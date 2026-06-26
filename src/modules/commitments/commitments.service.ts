import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';

// ─── Deadline Evaluation ───────────────────────────────────────────────────────

/**
 * Transitions any ACTIVE commitment contracts whose deadline has passed to
 * FAILED. Called by the queue job `handleContractDeadlineEval`, but exposed
 * separately so it can also be triggered inline (e.g., in a manual
 * administration endpoint).
 */
export async function evaluateDeadlines(userId?: string): Promise<number> {
  const now = new Date();

  const result = await prisma.commitmentContract.updateMany({
    where: {
      status: 'ACTIVE',
      endDate: { lte: now },
      ...(userId ? { userId } : {}),
    },
    data: { status: 'FORFEITED' },
  });

  return result.count;
}

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

  return prisma.commitmentContract.create({
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
