import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { Prisma, TransactionType } from '@prisma/client';
import { getCachedBalance, setCachedBalance, invalidateBalance } from '../../shared/cache/balance.js';

/**
 * Either the top-level PrismaClient or an interactive-transaction client
 * (`tx` inside a `prisma.$transaction(async (tx) => ...)` callback).
 *
 * Callers that are already inside their own transaction (pools, wheel,
 * commitments, contract evaluation) MUST pass their `tx` through so the
 * wallet write participates in that same transaction instead of opening a
 * second, independent one — nesting `prisma.$transaction` calls silently
 * decouples the inner write's commit from the outer transaction's, which is
 * a correctness bug (the inner write can persist even if the outer
 * transaction later rolls back). See CODE_REVIEW.md #10.
 */
type Db = typeof prisma | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export async function getBalance(
  userId: string,
): Promise<{ balance: number }> {
  const cached = getCachedBalance(userId);
  if (cached !== undefined) {
    return { balance: cached };
  }

  const wallet = await prisma.tokenWallet.findUnique({
    where: { userId },
  });

  const balance = wallet?.balance ?? 0;
  setCachedBalance(userId, balance);
  return { balance };
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

/**
 * Credits a wallet atomically. Uses a raw, guarded `UPDATE ... RETURNING`
 * instead of "read balance, compute newBalance in JS, write it back" — the
 * old pattern let two concurrent writers both read the same starting
 * balance and clobber each other's update (lost-update / double-spend race,
 * see CODE_REVIEW.md #1). The database now performs the arithmetic, so
 * concurrent credits/debits against the same wallet always serialize
 * correctly regardless of how many requests race.
 *
 * Pass `db` (the `tx` from an enclosing `prisma.$transaction`) when calling
 * this from code that's already inside its own transaction, so the wallet
 * write and the caller's other writes commit or roll back together.
 */
export async function creditTokens(
  userId: string,
  amount: number,
  type: TransactionType,
  description?: string,
  referenceId?: string,
  db: Db = prisma,
): Promise<{ balance: number }> {
  if (amount <= 0) {
    throw new AppError('Credit amount must be positive', 400);
  }

  const run = async (tx: Db): Promise<{ balance: number }> => {
    const wallet = await tx.tokenWallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new AppError('Token wallet not found', 404);
    }

    const updated = await tx.$queryRaw<{ balance: number }[]>`
      UPDATE "TokenWallet"
      SET balance = balance + ${amount}, "updatedAt" = NOW()
      WHERE id = ${wallet.id}
      RETURNING balance
    `;
    const newBalance = updated[0].balance;

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
  };

  const usingOwnTransaction = db === prisma;
  const result = usingOwnTransaction ? await prisma.$transaction(run) : await run(db);

  // Safe to invalidate even if we're inside a caller's not-yet-committed
  // transaction — worst case is one extra DB read on the next cache miss.
  invalidateBalance(userId);
  // Only warm the cache with the new value once we know the write actually
  // committed (i.e. we owned the transaction ourselves).
  if (usingOwnTransaction) {
    setCachedBalance(userId, result.balance);
  }
  return result;
}

/**
 * Explicit tx-scoped variant of `creditTokens`, for call sites (e.g.
 * `evaluateContract`) where naming the transaction client as the first
 * argument reads more clearly than a trailing optional parameter. Delegates
 * to `creditTokens` so there's exactly one implementation of the atomic
 * credit logic (the raw-SQL `UPDATE ... RETURNING` above).
 */
export async function creditTokensTx(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  type: TransactionType,
  description?: string,
  referenceId?: string,
): Promise<{ balance: number }> {
  return creditTokens(userId, amount, type, description, referenceId, tx);
}

// ---------------------------------------------------------------------------
// Debit tokens (atomic)
// ---------------------------------------------------------------------------

/**
 * Debits a wallet atomically and race-safely. The `WHERE balance >= amount`
 * guard on the raw UPDATE means the database itself enforces "never go
 * negative" even under concurrent debits — there is no window where two
 * requests can both pass a balance check based on stale data and both
 * succeed (see CODE_REVIEW.md #1).
 */
export async function debitTokens(
  userId: string,
  amount: number,
  type: TransactionType,
  description?: string,
  referenceId?: string,
  db: Db = prisma,
): Promise<{ balance: number }> {
  if (amount <= 0) {
    throw new AppError('Debit amount must be positive', 400);
  }

  const run = async (tx: Db): Promise<{ balance: number }> => {
    const wallet = await tx.tokenWallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new AppError('Token wallet not found', 404);
    }

    const updated = await tx.$queryRaw<{ balance: number }[]>`
      UPDATE "TokenWallet"
      SET balance = balance - ${amount}, "updatedAt" = NOW()
      WHERE id = ${wallet.id} AND balance >= ${amount}
      RETURNING balance
    `;

    if (updated.length === 0) {
      throw new AppError('Insufficient token balance', 400);
    }

    const newBalance = updated[0].balance;

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
  };

  const usingOwnTransaction = db === prisma;
  const result = usingOwnTransaction ? await prisma.$transaction(run) : await run(db);

  invalidateBalance(userId);
  if (usingOwnTransaction) {
    setCachedBalance(userId, result.balance);
  }
  return result;
}
