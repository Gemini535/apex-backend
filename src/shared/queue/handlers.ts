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

import type { BrainRecalcPayload, ContractDeadlineEvalPayload, StreakDecayPayload } from './jobs.js';
import { recalculateBrainState } from '../brain-engine.js';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';

// ─── Brain recalc ─────────────────────────────────────────────────────────────

export async function handleBrainRecalc(payload: BrainRecalcPayload): Promise<void> {
  await recalculateBrainState(payload.userId);
}

// ─── Contract deadline evaluation ──────────────────────────────────────────────

/**
 * Flips ACTIVE contracts whose deadline has passed to FAILED. If `userId` is
 * provided, only that user's contracts are evaluated; otherwise the function
 * sweeps every outstanding contract.
 *
 * The update is chunked and runs in short transactions so concurrent HTTP pool
 * users do not see long-held locks.
 */
export async function handleContractDeadlineEval(payload: ContractDeadlineEvalPayload): Promise<void> {
  const now = new Date();

  const where = {
    status: 'ACTIVE' as const,
    endDate: { lte: now },
    ...(payload.userId ? { userId: payload.userId } : {}),
  };

  // Paginate so we never lock thousands of rows in one transaction.
  const pageSize = 200;
  let cursor: string | undefined;
  let updatedTotal = 0;

  for (;;) {
    const contracts = await prisma.commitmentContract.findMany({
      where,
      select: { id: true },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (contracts.length === 0) break;

    const ids = contracts.map((c) => c.id);

    const result = await prisma.commitmentContract.updateMany({
      where: { id: { in: ids } },
      data: { status: 'FORFEITED' },
    });

    updatedTotal += result.count;
    if (contracts.length < pageSize) break;
    cursor = ids[ids.length - 1];
  }

  if (updatedTotal > 0) {
    logger.info(
      { count: updatedTotal, userId: payload.userId ?? 'all' },
      'Commitment contracts marked FORFEITED past deadline',
    );
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
