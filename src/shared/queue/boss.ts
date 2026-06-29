/**
 * pg-boss queue singleton.
 *
 * pg-boss stores jobs inside the existing Postgres instance (in a dedicated
 * `pgboss` schema) so we don't add Redis or any other infrastructure. The
 * worker runs inline in the same Node process as the Express server — worker
 * DB operations use the same Prisma pool and participate in transactions.
 *
 * Lifecycle:
 *   1. `await startBoss()` once after server boot — begins processing.
 *   2. `await boss.publish(name, data)` from any request handler — enqueue.
 *   3. `await stopBoss()` on SIGTERM — drain and exit cleanly.
 */

import PgBoss from 'pg-boss';
import type { Job } from 'pg-boss';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { JOBS } from './jobs.js';
import {
  handleBrainRecalc,
  handleContractResolveAll,
  handleStreakDecay,
} from './handlers.js';
import type {
  BrainRecalcPayload,
  StreakDecayPayload,
} from './jobs.js';

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

/**
 * Starts the queue worker if not already started. Safe to call multiple times —
 * concurrent callers await the same startup promise.
 */
export async function startBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;

  starting = (async () => {
    // pg-boss auto-creates its schema on start in DATABASE_URL.
    const instance = new PgBoss(env.database.url);

    instance.on('error', (err: Error) => {
      logger.error({ err, queue: 'pg-boss' }, 'Queue worker error');
    });

    await instance.start();

    // ─── Per-user jobs ───────────────────────────────────────────────────
    await instance.subscribe(
      JOBS.BRAIN_RECALC,
      { batchSize: 5 },
      (job: Job<BrainRecalcPayload>) => handleBrainRecalc(job.data),
    );

    await instance.subscribe(
      JOBS.STREAK_DECAY,
      { batchSize: 5 },
      (job: Job<StreakDecayPayload>) => handleStreakDecay(job.data),
    );

    // ─── Batch sweep jobs ────────────────────────────────────────────────
    await instance.subscribe(
      JOBS.CONTRACT_RESOLVE_ALL,
      { batchSize: 1 },
      () => handleContractResolveAll(),
    );

    // ─── Cron schedules ──────────────────────────────────────────────────
    // Hourly sweep: evaluate and resolve overdue commitment contracts.
    if (env.nodeEnv !== 'test') {
      await instance.schedule(JOBS.CONTRACT_RESOLVE_ALL, '0 * * * *');
    }

    boss = instance;
    starting = null;

    logger.info('pg-boss worker started');

    return instance;
  })();

  return starting;
}

/**
 * Stops the worker. Call from the server's shutdown path so in-flight jobs
 * complete (or time out) before the process exits.
 */
export async function stopBoss(): Promise<void> {
  if (!boss) return;
  const instance = boss;
  boss = null;
  starting = null;
  await instance.stop({ graceful: true, timeout: 10_000 });
}

/**
 * Enqueue a job. Caller gets back the job id or null if the queue rejected the
 * request (e.g. pg-boss hasn't started yet). Failures are logged so the request
 * path degrades gracefully — a failed enqueue does not throw.
 */
export async function enqueue<T extends object>(
  name: string,
  data: T,
  options?: PgBoss.PublishOptions,
): Promise<string | null> {
  if (!boss) {
    logger.warn({ name }, 'enqueue attempted before queue started');
    return null;
  }
  return options ? boss.publish(name, data, options) : boss.publish(name, data);
}

/** Returns the underlying pg-boss instance, or null if not started. */
export function getBoss(): PgBoss | null {
  return boss;
}
