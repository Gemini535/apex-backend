import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { PoolStatus, PoolLedgerType, TransactionType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Create pool
// ---------------------------------------------------------------------------

export async function createPool(
  creatorId: string,
  name: string,
  description: string | undefined,
  entryFee: number,
  maxParticipants: number | undefined,
  endsAt: Date,
) {
  const created = await prisma.$transaction(async (tx) => {
    // Verify creator has sufficient balance first
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId: creatorId },
    });
    if (!wallet) {
      throw new AppError('Token wallet not found', 404);
    }
    if (wallet.balance < entryFee) {
      throw new AppError('Insufficient token balance to create pool', 400);
    }

    const pool = await tx.pool.create({
      data: {
        creatorId,
        name,
        description,
        entryFee,
        maxParticipants,
        status: 'OPEN' as PoolStatus,
        potTotal: 0,
        endsAt,
      },
    });

    await tx.poolParticipant.create({
      data: {
        poolId: pool.id,
        userId: creatorId,
        entryFeePaid: entryFee,
      },
    });

    await tx.poolLedger.create({
      data: {
        poolId: pool.id,
        type: 'ENTRY_FEE' as PoolLedgerType,
        amount: entryFee,
        description: `Creator joined pool "${name}"`,
      },
    });

    // Deduct entry fee inside the same transaction
    const newBalance = wallet.balance - entryFee;
    await tx.tokenWallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance },
    });
    await tx.tokenTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -entryFee,
        type: 'POOL_ENTRY' as TransactionType,
        description: `Joined pool "${name}"`,
        referenceId: pool.id,
        balanceAfter: newBalance,
      },
    });

    await tx.pool.update({
      where: { id: pool.id },
      data: { potTotal: entryFee },
    });

    return pool;
  });

  return getPool(created.id);
}

// ---------------------------------------------------------------------------
// Join pool
// ---------------------------------------------------------------------------

export async function joinPool(poolId: string, userId: string) {
  const entryFee = await prisma.$transaction(async (tx) => {
    const pool = await tx.pool.findUnique({
      where: { id: poolId },
      include: { participants: true },
    });

    if (!pool) {
      throw new AppError('Pool not found', 404);
    }

    if (pool.status !== 'OPEN') {
      throw new AppError('Pool is not open for joining', 400);
    }

    if (pool.creatorId === userId) {
      throw new AppError('Creator is already a participant', 400);
    }

    const alreadyJoined = pool.participants.some(
      (p) => p.userId === userId,
    );
    if (alreadyJoined) {
      throw new AppError('You are already a participant in this pool', 400);
    }

    // Check if the creator has blocked this user
    const creatorBlocked = await tx.blockedUser.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId: pool.creatorId,
          blockedId: userId,
        },
      },
    });
    if (creatorBlocked) {
      throw new AppError('You have been blocked from this pool', 403);
    }

    if (
      pool.maxParticipants !== null &&
      pool.participants.length >= pool.maxParticipants
    ) {
      throw new AppError('Pool is full', 400);
    }

    // Verify user has sufficient balance
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId },
    });
    if (!wallet) {
      throw new AppError('Token wallet not found', 404);
    }
    if (wallet.balance < pool.entryFee) {
      throw new AppError('Insufficient token balance to join pool', 400);
    }

    // Deduct entry fee inside the same transaction
    const newBalance = wallet.balance - pool.entryFee;
    await tx.tokenWallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance },
    });
    await tx.tokenTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -pool.entryFee,
        type: 'POOL_ENTRY' as TransactionType,
        description: `Joined pool`,
        referenceId: poolId,
        balanceAfter: newBalance,
      },
    });

    await tx.poolParticipant.create({
      data: {
        poolId,
        userId,
        entryFeePaid: pool.entryFee,
      },
    });

    await tx.poolLedger.create({
      data: {
        poolId,
        type: 'ENTRY_FEE' as PoolLedgerType,
        amount: pool.entryFee,
        description: `User ${userId} joined pool`,
      },
    });

    const updatedPotTotal = pool.potTotal + pool.entryFee;
    await tx.pool.update({
      where: { id: poolId },
      data: { potTotal: updatedPotTotal },
    });

    return pool.entryFee;
  });

  return getPool(poolId);
}

// ---------------------------------------------------------------------------
// Leave pool
// ---------------------------------------------------------------------------

export async function leavePool(poolId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.pool.findUnique({
      where: { id: poolId },
      include: { participants: true },
    });

    if (!existing) {
      throw new AppError('Pool not found', 404);
    }

    if (existing.status !== 'OPEN') {
      throw new AppError('Cannot leave a pool that is not open', 400);
    }

    const participant = existing.participants.find(
      (p) => p.userId === userId,
    );
    if (!participant) {
      throw new AppError('You are not a participant in this pool', 400);
    }

    if (existing.creatorId === userId) {
      throw new AppError('Creator cannot leave the pool', 400);
    }

    await tx.poolParticipant.update({
      where: { id: participant.id },
      data: { leftAt: new Date() },
    });

    await tx.poolLedger.create({
      data: {
        poolId,
        type: 'REFUND' as PoolLedgerType,
        amount: participant.entryFeePaid,
        description: `User ${userId} left pool (refund)`,
      },
    });

    const updatedPotTotal =
      existing.potTotal - participant.entryFeePaid;
    await tx.pool.update({
      where: { id: poolId },
      data: { potTotal: updatedPotTotal },
    });

    // Refund entry fee inside the same transaction
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId },
    });
    if (wallet) {
      const newBalance = wallet.balance + participant.entryFeePaid;
      await tx.tokenWallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance },
      });
      await tx.tokenTransaction.create({
        data: {
          walletId: wallet.id,
          amount: participant.entryFeePaid,
          type: 'POOL_REFUND' as TransactionType,
          description: `Left pool (refund)`,
          referenceId: poolId,
          balanceAfter: newBalance,
        },
      });
    }
  });

  return getPool(poolId);
}

// ---------------------------------------------------------------------------
// Get single pool
// ---------------------------------------------------------------------------

export async function getPool(poolId: string) {
  const pool = await prisma.pool.findUnique({
    where: { id: poolId },
    include: {
      participants: {
        include: {
          user: {
            select: {
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
      },
      _count: {
        select: { participants: true },
      },
    },
  });

  if (!pool) {
    throw new AppError('Pool not found', 404);
  }

  const creator = await prisma.user.findUnique({
    where: { id: pool.creatorId },
    select: { username: true },
  });

  return {
    id: pool.id,
    creatorId: pool.creatorId,
    creatorUsername: creator?.username ?? '',
    name: pool.name,
    description: pool.description,
    entryFee: pool.entryFee,
    maxParticipants: pool.maxParticipants,
    status: pool.status,
    potTotal: pool.potTotal,
    participantCount: pool._count.participants,
    participants: pool.participants.map((p) => ({
      userId: p.userId,
      username: p.user.username,
      displayName: p.user.displayName,
      avatarUrl: p.user.avatarUrl,
      entryFeePaid: p.entryFeePaid,
      tokensWon: p.tokensWon,
      focusScore: p.focusScore,
      joinedAt: p.joinedAt,
    })),
    startedAt: pool.startedAt,
    endsAt: pool.endsAt,
    settledAt: pool.settledAt,
    createdAt: pool.createdAt,
  };
}

// ---------------------------------------------------------------------------
// List pools
// ---------------------------------------------------------------------------

export async function listPools(
  status?: string,
  page = 1,
  limit = 20,
) {
  const skip = (page - 1) * limit;

  const where = status ? { status: status as PoolStatus } : {};

  const [pools, total] = await Promise.all([
    prisma.pool.findMany({
      where,
      include: {
        _count: { select: { participants: true } },
        creator: { select: { username: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.pool.count({ where }),
  ]);

  return {
    pools: pools.map((p) => ({
      id: p.id,
      creatorId: p.creatorId,
      creatorUsername: p.creator.username,
      name: p.name,
      description: p.description,
      entryFee: p.entryFee,
      maxParticipants: p.maxParticipants,
      status: p.status,
      potTotal: p.potTotal,
      participantCount: p._count.participants,
      participants: [],
      startedAt: p.startedAt,
      endsAt: p.endsAt,
      settledAt: p.settledAt,
      createdAt: p.createdAt,
    })),
    total,
    page,
    limit,
  };
}

// ---------------------------------------------------------------------------
// Settle pool
// ---------------------------------------------------------------------------

export async function settlePool(
  poolId: string,
  winnerUserId: string,
) {
  // Everything — pool state update + wallet credit — happens in a single
  // Prisma transaction so that a crash can never leave the pool SETTLED
  // without the winner being paid.
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.pool.findUnique({
      where: { id: poolId },
      include: { participants: true },
    });

    if (!existing) {
      throw new AppError('Pool not found', 404);
    }

    if (existing.endsAt >= new Date()) {
      throw new AppError('Pool has not ended yet', 400);
    }

    if (
      existing.status !== ('OPEN' as PoolStatus) &&
      existing.status !== ('ACTIVE' as PoolStatus)
    ) {
      throw new AppError(
        'Pool can only be settled from OPEN or ACTIVE status',
        400,
      );
    }

    const winner = existing.participants.find(
      (p) => p.userId === winnerUserId,
    );
    if (!winner) {
      throw new AppError(
        'Winner must be a participant in the pool',
        400,
      );
    }

    // Calculate placeholder focus scores for all participants
    const participantScores = existing.participants.map((p) => ({
      participant: p,
      focusScore: Math.random() * 100, // placeholder — real logic from screen time data
    }));

    for (const ps of participantScores) {
      await tx.poolParticipant.update({
        where: { id: ps.participant.id },
        data: { focusScore: ps.focusScore },
      });
    }

    // Calculate platform fee (10%)
    const platformFee = Math.floor(existing.potTotal * 0.1);
    const winnerPayout = existing.potTotal - platformFee;

    // Update pool status
    await tx.pool.update({
      where: { id: poolId },
      data: {
        status: 'SETTLED' as PoolStatus,
        settledAt: new Date(),
      },
    });

    // Award tokens won to winner participant record
    await tx.poolParticipant.update({
      where: { id: winner.id },
      data: { tokensWon: winnerPayout },
    });

    // Create ledger entries
    await tx.poolLedger.createMany({
      data: [
        {
          poolId,
          type: 'PLATFORM_FEE' as PoolLedgerType,
          amount: platformFee,
          description: `Platform fee (10%)`,
        },
        {
          poolId,
          type: 'WINNING_PAYOUT' as PoolLedgerType,
          amount: winnerPayout,
          description: `Winner payout to ${winnerUserId}`,
        },
      ],
    });

    // Credit winner's wallet INSIDE the same transaction
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId: winnerUserId },
    });
    if (!wallet) {
      throw new AppError('Winner token wallet not found', 404);
    }
    const newBalance = wallet.balance + winnerPayout;
    await tx.tokenWallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance },
    });
    await tx.tokenTransaction.create({
      data: {
        walletId: wallet.id,
        amount: winnerPayout,
        type: 'POOL_WIN' as TransactionType,
        description: `Won pool`,
        referenceId: poolId,
        balanceAfter: newBalance,
      },
    });

    return { poolId, winnerPayout };
  });

  return getPool(result.poolId);
}

// ---------------------------------------------------------------------------
// Get pool ledger
// ---------------------------------------------------------------------------

export async function getPoolLedger(poolId: string) {
  const entries = await prisma.poolLedger.findMany({
    where: { poolId },
    orderBy: { createdAt: 'asc' },
  });

  return {
    ledger: entries.map((e) => ({
      id: e.id,
      type: e.type,
      amount: e.amount,
      description: e.description,
      createdAt: e.createdAt,
    })),
  };
}
