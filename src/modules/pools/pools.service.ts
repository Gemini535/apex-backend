import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { PoolLedgerType, PoolStatus } from '@prisma/client';
import { creditTokens, debitTokens } from '../tokens/tokens.service.js';
import { getRangeData } from '../screentime/screentime.service.js';

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

    // Atomic, race-safe debit that participates in this same transaction via
    // `tx` — pool creation and the entry-fee charge commit or roll back
    // together, and the underlying wallet write is guarded against
    // concurrent overdraft (see tokens.service.ts). This replaces the old
    // pattern of reading the wallet balance outside the transaction and
    // writing back a computed absolute value, which was a lost-update race
    // (CODE_REVIEW.md #1).
    await debitTokens(creatorId, entryFee, 'POOL_ENTRY', `Joined pool "${name}"`, pool.id, tx);

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
  await prisma.$transaction(async (tx) => {
    // Row-lock the pool for the duration of this transaction so concurrent
    // joins (or a join racing a settle) against the same pool serialize
    // instead of both reading a stale participant count / potTotal and
    // overshooting maxParticipants (CODE_REVIEW.md #13).
    await tx.$executeRaw`SELECT id FROM "Pool" WHERE id = ${poolId} FOR UPDATE`;

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
    if (pool.endsAt <= new Date()) {
      throw new AppError('Pool has already ended', 400);
    }
    if (pool.creatorId === userId) {
      throw new AppError('Creator is already a participant', 400);
    }
    if (pool.participants.some((p) => p.userId === userId)) {
      throw new AppError('You are already a participant in this pool', 400);
    }
    if (pool.maxParticipants !== null && pool.participants.length >= pool.maxParticipants) {
      throw new AppError('Pool is full', 400);
    }

    await debitTokens(userId, pool.entryFee, 'POOL_ENTRY', 'Joined pool', poolId, tx);

    await tx.poolParticipant.create({
      data: { poolId, userId, entryFeePaid: pool.entryFee },
    });

    await tx.poolLedger.create({
      data: {
        poolId,
        type: 'ENTRY_FEE' as PoolLedgerType,
        amount: pool.entryFee,
        description: `User ${userId} joined pool`,
      },
    });

    await tx.pool.update({
      where: { id: poolId },
      data: { potTotal: pool.potTotal + pool.entryFee },
    });
  });

  return getPool(poolId);
}

// ---------------------------------------------------------------------------
// Leave pool
// ---------------------------------------------------------------------------

export async function leavePool(poolId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    // Same row-lock rationale as joinPool.
    await tx.$executeRaw`SELECT id FROM "Pool" WHERE id = ${poolId} FOR UPDATE`;

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
    const participant = existing.participants.find((p) => p.userId === userId && !p.leftAt);
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

    await tx.pool.update({
      where: { id: poolId },
      data: { potTotal: existing.potTotal - participant.entryFeePaid },
    });

    await creditTokens(userId, participant.entryFeePaid, 'POOL_REFUND', 'Left pool (refund)', poolId, tx);
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
      leftAt: p.leftAt,
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

/**
 * Fraction of the pot taken as a platform fee on settlement.
 */
const PLATFORM_FEE_RATE = 0.1;

interface ParticipantScore {
  participantId: string;
  userId: string;
  entryFeePaid: number;
  avgHealth: number;
}

/**
 * Computes each active participant's real focus/brain-health score across
 * the pool's active window, instead of trusting a client-supplied winner.
 *
 * Previously `settlePool` accepted an arbitrary `winnerUserId` from the
 * request body and paid that participant out with zero verification — any
 * pool creator could declare themselves (or a friend) the winner and
 * collect the pot. See CODE_REVIEW.md #2.
 */
async function scoreParticipants(
  poolCreatedAt: Date,
  poolEndsAt: Date,
  participants: { id: string; userId: string; entryFeePaid: number; joinedAt: Date; leftAt: Date | null }[],
): Promise<ParticipantScore[]> {
  const active = participants.filter((p) => !p.leftAt);

  return Promise.all(
    active.map(async (p) => {
      const windowStart = poolCreatedAt > p.joinedAt ? poolCreatedAt : p.joinedAt;
      const summaries = await getRangeData(p.userId, windowStart, poolEndsAt);
      const avgHealth =
        summaries.length > 0
          ? summaries.reduce((sum, s) => sum + s.brainHealth, 0) / summaries.length
          : 0;

      return {
        participantId: p.id,
        userId: p.userId,
        entryFeePaid: p.entryFeePaid,
        avgHealth,
      };
    }),
  );
}

/**
 * Settles a pool once its deadline has passed. The winner (or winners, in
 * the event of a tie) is derived entirely from each participant's real
 * screen-time/focus data over the pool's active window — the caller cannot
 * pick who gets paid. If nobody has any qualifying activity data, every
 * participant is refunded in full rather than an arbitrary payout being
 * made.
 *
 * Double-settlement is prevented by an atomic conditional `UPDATE` that
 * flips the pool's status away from OPEN/ACTIVE: Postgres takes a row lock
 * for the duration of that UPDATE, so a second concurrent settle call
 * blocks until the first commits, then observes `count === 0` and fails
 * cleanly instead of paying out twice (CODE_REVIEW.md #2).
 */
export async function settlePool(poolId: string) {
  const existing = await prisma.pool.findUnique({
    where: { id: poolId },
    include: { participants: true },
  });
  if (!existing) {
    throw new AppError('Pool not found', 404);
  }
  if (existing.endsAt >= new Date()) {
    throw new AppError('Pool has not ended yet', 400);
  }
  if (existing.status !== ('OPEN' as PoolStatus) && existing.status !== ('ACTIVE' as PoolStatus)) {
    throw new AppError('Pool can only be settled from OPEN or ACTIVE status', 400);
  }

  const activeParticipants = existing.participants.filter((p) => !p.leftAt);
  if (activeParticipants.length === 0) {
    throw new AppError('Pool has no remaining participants to settle', 400);
  }

  // Data-derived scoring happens before we take the settlement lock so the
  // (potentially slower) screen-time aggregation doesn't hold a row lock.
  const scores = await scoreParticipants(existing.createdAt, existing.endsAt, existing.participants);
  const bestScore = Math.max(...scores.map((s) => s.avgHealth));
  const winners = bestScore > 0 ? scores.filter((s) => s.avgHealth === bestScore) : [];

  await prisma.$transaction(async (tx) => {
    const guard = await tx.pool.updateMany({
      where: { id: poolId, status: { in: ['OPEN', 'ACTIVE'] } },
      data: { status: 'SETTLED' as PoolStatus, settledAt: new Date() },
    });
    if (guard.count === 0) {
      throw new AppError('Pool has already been settled', 409);
    }

    // Re-read the pot total now that we hold the settlement lock, so any
    // join/leave that raced us in but lost is correctly reflected.
    const locked = await tx.pool.findUniqueOrThrow({ where: { id: poolId } });

    // Persist real, data-derived focus scores for every active participant.
    for (const s of scores) {
      await tx.poolParticipant.update({
        where: { id: s.participantId },
        data: { focusScore: s.avgHealth },
      });
    }

    if (winners.length === 0) {
      // Nobody had any qualifying activity data during the pool window —
      // there's no fair basis to declare a winner, so refund everyone.
      for (const p of activeParticipants) {
        await tx.poolLedger.create({
          data: {
            poolId,
            type: 'REFUND' as PoolLedgerType,
            amount: p.entryFeePaid,
            description: `No verifiable activity data — refunding ${p.userId}`,
          },
        });
        await creditTokens(
          p.userId,
          p.entryFeePaid,
          'POOL_REFUND',
          `Pool "${existing.name}" cancelled: no activity data to determine a winner`,
          poolId,
          tx,
        );
      }
      return;
    }

    const platformFee = Math.floor(locked.potTotal * PLATFORM_FEE_RATE);
    const payoutPool = locked.potTotal - platformFee;
    const share = Math.floor(payoutPool / winners.length);

    await tx.poolLedger.create({
      data: {
        poolId,
        type: 'PLATFORM_FEE' as PoolLedgerType,
        amount: platformFee,
        description: `Platform fee (${Math.round(PLATFORM_FEE_RATE * 100)}%)`,
      },
    });

    for (const winner of winners) {
      await tx.poolParticipant.update({
        where: { id: winner.participantId },
        data: { tokensWon: share },
      });

      await tx.poolLedger.create({
        data: {
          poolId,
          type: 'WINNING_PAYOUT' as PoolLedgerType,
          amount: share,
          description: `Winner payout to ${winner.userId} (focus score ${winner.avgHealth.toFixed(1)})`,
        },
      });

      await creditTokens(
        winner.userId,
        share,
        'POOL_WIN',
        `Won pool "${existing.name}" (focus score ${winner.avgHealth.toFixed(1)})`,
        poolId,
        tx,
      );
    }
  });

  return getPool(poolId);
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
