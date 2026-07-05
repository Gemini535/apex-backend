/**
 * Single-commitment-contract resolver.
 *
 * Evaluates whether a user met their screen-time goal over the contract window
 * and resolves the contract — crediting the pledge back on success, leaving
 * the debit in place on failure.
 *
 * Goal evaluation is data-driven and auditable:
 *   - Slice the contract window into local days (timezone-aware).
 *   - For each day, sum the user's focus seconds.
 *   - A day "hits" if focusSeconds >= targetScreenTime.
 *   - The contract is "met" if the hit-rate across all days is at least
 *     `CONTRACT_GOAL_THRESHOLD` (default 0.6 = 60%).
 *
 * The threshold is intentionally below 100% — a daily target is strict, and
 * life happens. 60% rewards consistent effort without requiring perfection.
 *
 * Safe to call on already-resolved contracts: the first thing the transaction
 * does is check `status === ACTIVE`, so repeat calls are no-ops.
 */

import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import { getRangeData } from '../../modules/screentime/screentime.service.js';
import { creditTokens } from '../../modules/tokens/tokens.service.js';
import { appEvents } from '../events.js';

/** Fraction of days the user must hit their target to "pass" the contract. */
export function goalThreshold(): number {
  const raw = process.env.CONTRACT_GOAL_THRESHOLD ?? '0.6';
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 1) return 0.6;
  return parsed;
}

export interface ContractResolution {
  contractId: string;
  status: 'COMPLETED' | 'FORFEITED';
  daysTotal: number;
  daysHit: number;
  hitRate: number;
  pledgeAmount: number;
}

/**
 * Resolve a single commitment contract. Idempotent: if the contract is not
 * ACTIVE, returns its existing status without doing anything.
 */
export async function evaluateContract(
  contractId: string,
): Promise<ContractResolution | null> {
  const threshold = goalThreshold();

  return prisma.$transaction(async (tx) => {
    const contract = await tx.commitmentContract.findUnique({
      where: { id: contractId },
    });

    if (!contract) {
      throw new AppError('Contract not found', 404);
    }

    if (contract.status !== 'ACTIVE') {
      // Idempotent skip — already resolved by a previous run.
      logger.debug({ contractId, status: contract.status }, 'Contract already resolved, skipping');
      return null;
    }

    if (contract.endDate.getTime() > Date.now()) {
      // Not yet past deadline — leave it alone.
      logger.debug({ contractId, endDate: contract.endDate }, 'Contract not yet past deadline');
      return null;
    }

    // Slice the contract window into local days (timezone-aware, per
    // `getRangeData`) and sum focus seconds per day.
    const dailySummaries = await getRangeData(
      contract.userId,
      contract.startDate,
      contract.endDate,
    );

    const daysTotal = Math.max(
      Math.ceil(
        (contract.endDate.getTime() - contract.startDate.getTime()) / 86_400_000,
      ),
      1,
    );

    // Count days where focus met the target. Days with no screen time data
    // count as 0 focus seconds — a miss.
    const daysHit = dailySummaries.filter(
      (s) => s.focusSeconds >= contract.targetScreenTime,
    ).length;

    const hitRate = daysHit / daysTotal;
    const met = hitRate >= threshold;

// Fetch the wallet once so the FORFEITED branch (which doesn't move any
    // money) can still write a ledger marker with an accurate balanceAfter.
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId: contract.userId },
    });
    if (!wallet) {
      throw new AppError('Token wallet not found', 404);
    }

    if (met) {
      // Credit the pledge back. `tx` is threaded through so this write
      // commits/rolls back atomically together with the contract's status
      // update below — previously this called `creditTokens` without `tx`,
      // which opened its OWN independent transaction; if anything after it
      // in this function later failed, the credit would already have
      // committed while the contract stayed ACTIVE, and a retry could pay
      // the pledge out a second time (CODE_REVIEW.md #10). Using
      // 'CONTRACT_PAYOUT' as the ledger type here (rather than a generic
      // 'EARNED') also means this is the single, correctly-categorized
      // ledger row for the payout — the old code additionally wrote a
      // second manual 'CONTRACT_PAYOUT' transaction for the same amount,
      // double-counting the payout in the user's transaction history even
      // though the wallet balance only actually increased once.
      await creditTokens(
        contract.userId,
        contract.pledgeAmount,
        'CONTRACT_PAYOUT',
        `Payout for completed commitment: ${contract.name}`,
        contract.id,
        tx,
      );

      await tx.commitmentContract.update({
        where: { id: contractId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });

      logger.info(
        { contractId, userId: contract.userId, daysHit, daysTotal, hitRate },
        'Commitment contract COMPLETED',
      );
    } else {
      // Forfeited: the original debit stands. Write a ledger marker so the
      // forfeit is auditable. balanceAfter reflects the post-stake balance.
      await tx.commitmentContract.update({
        where: { id: contractId },
        data: { status: 'FORFEITED', forfeitedAt: new Date() },
      });

      await tx.tokenTransaction.create({
        data: {
          walletId: wallet.id,
          amount: 0,
          type: 'CONTRACT_FORFEIT',
          description: `Forfeited commitment: ${contract.name} (${daysHit}/${daysTotal} days hit)`,
          balanceAfter: wallet.balance,
          referenceId: contractId,
        },
      });

      logger.info(
        { contractId, userId: contract.userId, daysHit, daysTotal, hitRate },
        'Commitment contract FORFEITED',
      );
    }

    const resolution = {
      contractId,
      status: (met ? 'COMPLETED' : 'FORFEITED') as 'COMPLETED' | 'FORFEITED',
      daysTotal,
      daysHit,
      hitRate,
      pledgeAmount: contract.pledgeAmount,
    };

    // Emit the event so push notification listeners fire. Fire-and-forget —
    // the resolution already committed in this transaction.
    const { contractId: _, ...rest } = resolution;
    appEvents.emit('contract:resolved', {
      userId: contract.userId,
      contractId,
      name: contract.name,
      ...rest,
    });

    return resolution;
  });
}

