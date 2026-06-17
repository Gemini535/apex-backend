import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { TransactionType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export async function getBalance(
  userId: string,
): Promise<{ balance: number }> {
  const wallet = await prisma.tokenWallet.findUnique({
    where: { userId },
  });

  return { balance: wallet?.balance ?? 0 };
}

// ---------------------------------------------------------------------------
// Transaction history
// ---------------------------------------------------------------------------

export interface PaginatedTransactions {
  transactions: {
    id: string;
    amount: number;
    type: TransactionType;
    description: string | null;
    referenceId: string | null;
    balanceAfter: number;
    createdAt: Date;
  }[];
  total: number;
  page: number;
  limit: number;
}

export async function getTransactions(
  userId: string,
  page = 1,
  limit = 20,
): Promise<PaginatedTransactions> {
  const wallet = await prisma.tokenWallet.findUnique({
    where: { userId },
  });

  if (!wallet) {
    return { transactions: [], total: 0, page, limit };
  }

  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.tokenTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.tokenTransaction.count({
      where: { walletId: wallet.id },
    }),
  ]);

  return { transactions, total, page, limit };
}

// ---------------------------------------------------------------------------
// Credit tokens (atomic)
// ---------------------------------------------------------------------------

export async function creditTokens(
  userId: string,
  amount: number,
  type: TransactionType,
  description?: string,
  referenceId?: string,
): Promise<{ balance: number }> {
  if (amount <= 0) {
    throw new AppError('Credit amount must be positive', 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new AppError('Token wallet not found', 404);
    }

    const newBalance = wallet.balance + amount;

    await tx.tokenWallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance },
    });

    await tx.tokenTransaction.create({
      data: {
        walletId: wallet.id,
        amount,
        type,
        description: description ?? null,
        referenceId: referenceId ?? null,
        balanceAfter: newBalance,
      },
    });

    return { balance: newBalance };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Debit tokens (atomic)
// ---------------------------------------------------------------------------

export async function debitTokens(
  userId: string,
  amount: number,
  type: TransactionType,
  description?: string,
  referenceId?: string,
): Promise<{ balance: number }> {
  if (amount <= 0) {
    throw new AppError('Debit amount must be positive', 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new AppError('Token wallet not found', 404);
    }

    if (wallet.balance < amount) {
      throw new AppError('Insufficient token balance', 400);
    }

    const newBalance = wallet.balance - amount;

    await tx.tokenWallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance },
    });

    await tx.tokenTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -amount,
        type,
        description: description ?? null,
        referenceId: referenceId ?? null,
        balanceAfter: newBalance,
      },
    });

    return { balance: newBalance };
  });

  return result;
}
