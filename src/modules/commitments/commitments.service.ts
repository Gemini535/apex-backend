import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { debitTokens } from '../tokens/tokens.service.js';

// ─── Deadline Evaluation ───────────────────────────────────────────────────────
//
// NOTE: There used to be an `evaluateDeadlines` helper here that blindly
// force-forfeited every overdue ACTIVE contract with no screen-time
// evaluation at all, with a docstring falsely claiming it was "called by the
// queue job handleContractResolveAll". It was never actually wired into
// anything (grep confirmed zero callers) — the real, data-driven resolution
// logic lives in `src/shared/queue/evaluate-contract.ts`'s `evaluateContract`,
// which IS what the queue job calls. That dead function has been removed so
// nobody accidentally reconnects it and silently forfeits contracts users
// actually won (see CODE_REVIEW.md #23).

// ─── Commitment Contracts ─────────────────────────────────────────────────────

export async function createContract(
  userId: string,
  data: {
    name: string;
    description?: string;
    pledgeAmountCents: number;
    targetScreenTime: number; // seconds per day
    startDate: Date;
    endDate: Date;
    charityName?: string;
  }
) {
  if (data.pledgeAmountCents < 100) {
    throw new AppError('Minimum pledge is $1.00', 400);
  }
  if (data.endDate <= data.startDate) {
    throw new AppError('End date must be after start date', 400);
  }

  // Create the contract row first, then debit the pledge referencing its id
  // directly — no more create-with-null-reference-then-backfill dance. The
  // debit is the "stake": if the contract completes we credit it back; if
  // it's forfeited the debit stands. Both writes share this transaction via
  // `tx`, and the debit itself is atomic/race-safe (see tokens.service.ts),
  // so a concurrent request against the same wallet can't cause a lost
  // update or let the pledge go through without sufficient balance.
  return prisma.$transaction(async (tx) => {
    const contract = await tx.commitmentContract.create({
      data: {
        userId,
        name: data.name,
        description: data.description,
        pledgeAmount: data.pledgeAmountCents,
        targetScreenTime: data.targetScreenTime,
        startDate: data.startDate,
        endDate: data.endDate,
        charityName: data.charityName,
        status: 'ACTIVE',
      },
    });

    await debitTokens(
      userId,
      data.pledgeAmountCents,
      'CONTRACT_STAKE',
      `Stake for commitment: ${data.name}`,
      contract.id,
      tx,
    );

    return contract;
  });
}

export async function getUserContracts(userId: string) {
  return prisma.commitmentContract.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function cancelContract(userId: string, contractId: string) {
  const contract = await prisma.commitmentContract.findFirst({
    where: { id: contractId, userId },
  });
  if (!contract) {
    throw new AppError('Contract not found', 404);
  }
  if (contract.status !== 'ACTIVE') {
    throw new AppError(`Contract is already ${contract.status.toLowerCase()}`, 400);
  }

  return prisma.commitmentContract.update({
    where: { id: contractId },
    data: { status: 'CANCELLED' },
  });
}
