/**
 * Job handlers.
 *
 * Each function is a self-contained unit of work invoked by the pg-boss worker
 * for the matching job name (see `JOBS`). Handlers must be idempotent: pg-boss
 * will retry them on failures, potentially more than once.
 *
 * Long-running handlers should chunk their work so a single transaction does not
 * hold locks for seconds.
 */

import type { BrainRecalcPayload, StreakDecayPayload } from './jobs.js';
import { recalculateBrainState } from '../brain-engine.js';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { invalidateBrainState } from '../cache/brainState.js';
import { evaluateContract } from './evaluate-contract.js';

// ─── Brain recalc ─────────────────────────────────────────────────────────────

export async function handleBrainRecalc(payload: BrainRecalcPayload): Promise<void> {
  await recalculateBrainState(payload.userId);
  // The DB upsert is done inside recalculateBrainState; invalidate the cache so
  // the next read repopulates with fresh data.
  invalidateBrainState(payload.userId);
}

// ─── Contract resolution sweep ─────────────────────────────────────────────────

/**
 * Sweep every overdue ACTIVE commitment contract and resolve each one via
 * `evaluateContract`. Chunks work to avoid long-held locks and batched DB
 * round-trips. Each contract resolution is its own transaction, so one
 * failure does not roll back the others.
 */
export async function handleContractResolveAll(): Promise<void> {
  const now = new Date();
  const pageSize = 50;
  let cursor: string | undefined;
  let processedTotal = 0;

  for (;;) {
    const contracts = await prisma.commitmentContract.findMany({
      where: {
        status: 'ACTIVE',
        endDate: { lte: now },
      },
      select: { id: true },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });

    if (contracts.length === 0) break;

    for (const contract of contracts) {
      try {
        const result = await evaluateContract(contract.id);
        if (result) {
          processedTotal += 1;
          logger.debug(
            { contractId: contract.id, status: result.status },
            'Contract resolved by hourly job',
          );
        }
      } catch (err) {
        // Per-contract failures must not abort the sweep.
        logger.error({ err, contractId: contract.id }, 'Failed to resolve contract');
      }
    }

    if (contracts.length < pageSize) break;
    cursor = contracts[contracts.length - 1].id;
  }

  if (processedTotal > 0) {
    logger.info({ count: processedTotal }, 'Hourly contract sweep resolved contracts');
  }
}

// ─── Streak evaluation ────────────────────────────────────────────────────────

/**
 * Re-evaluates a user's streak and persists it. Called periodically so that
 * users who miss their focus target lose the streak promptly rather than on
 * their next brain recalc.
 */
export async function handleStreakDecay(payload: StreakDecayPayload): Promise<{ currentStreak: number }> {
  const { evaluateStreak } = await import('../../modules/users/streak.service.js');
  const result = await evaluateStreak(payload.userId);

  logger.debug(
    { userId: payload.userId, currentStreak: result.currentStreak, todayStatus: result.todayStatus },
    'Streak re-evaluated by queue job',
  );

  return { currentStreak: result.currentStreak };
}
