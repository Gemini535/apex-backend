import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { PoolLedgerType, PoolStatus } from '@prisma/client';
import { creditTokens, debitTokens } from '../tokens/tokens.service.js';
import { getWindowHealth, getAttestedWindowHealth } from '../screentime/screentime.service.js';
import { getEnforcementMode } from '../attestation/attestation.service.js';

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
        // Pools start immediately on creation — there's no separate "activate"
        // step. This is what the join cutoff and settlement scoring window
        // are anchored to.
        startedAt: new Date(),
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
    // Fixed-cohort rule: once the join grace window after pool creation has
    // elapsed, the roster locks — a late joiner would otherwise be scored at
    // settlement over a shared window they weren't meaningfully present for.
    if (pool.startedAt && Date.now() > pool.startedAt.getTime() + env.pools.joinGraceMs) {
      throw new AppError('Pool has already started — no new participants may join', 400);
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

/** Fraction of the pot taken as a platform fee on settlement. */
const PLATFORM_FEE_RATE = 0.1;

/**
 * Settles a pool once its deadline has passed. The winner is derived
 * entirely from each active participant's real screen-time/focus-health
 * data over the pool's shared settlement window — the caller cannot pick
 * who gets paid (CODE_REVIEW.md #2). If nobody clears the coverage floor
 * (see getWindowHealth/getAttestedWindowHealth), every participant is
 * refunded in full and the pool is cancelled instead of an arbitrary payout
 * being made.
 *
 * Double-settlement is prevented by a two-phase lock: the transaction first
 * atomically claims `SETTLING` (a conditional UPDATE that only succeeds if
 * the pool is still OPEN/ACTIVE — Postgres holds a row lock for the
 * duration, so a concurrent settle call blocks, then observes `count === 0`
 * and fails cleanly), then finalizes to SETTLED or CANCELLED at the end of
 * the same transaction, re-asserting `status: 'SETTLING'` on that final
 * update too so nothing else can interleave.
 */
export async function settlePool(poolId: string) {
  // Fast fail-fast reads outside the transaction — the real guard is the
  // atomic SETTLING claim inside the transaction below.
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
  if (
    existing.status !== ('OPEN' as PoolStatus) &&
    existing.status !== ('ACTIVE' as PoolStatus)
  ) {
    throw new AppError('Pool can only be settled from OPEN or ACTIVE status', 400);
  }

  // Participants who already left were refunded at leave-time — they aren't
  // eligible to be scored, win, or be refunded again here.
  const activeParticipants = existing.participants.filter((p) => !p.leftAt);
  if (activeParticipants.length === 0) {
    throw new AppError('Pool has no remaining participants to settle', 400);
  }

  // Shared window for every participant (not per-participant joinedAt) —
  // a deliberate fixed-cohort decision paired with the join-cutoff above,
  // so nobody is scored over time they weren't meaningfully present for.
  const windowStart = existing.startedAt ?? existing.createdAt;
  const mode = getEnforcementMode();
  const scoreFn = mode === 'strict' ? getAttestedWindowHealth : getWindowHealth;

  await prisma.$transaction(async (tx) => {
    // Atomically claim the SETTLING lock. A concurrent settlePool() call
    // serializes behind this update on the row and then sees status no
    // longer IN (OPEN, ACTIVE) — count is 0, so it fails the claim instead
    // of double-settling.
    const claim = await tx.pool.updateMany({
      where: { id: poolId, status: { in: ['OPEN', 'ACTIVE'] as PoolStatus[] } },
      data: { status: 'SETTLING' as PoolStatus },
    });
    if (claim.count === 0) {
      throw new AppError('Pool is already being settled', 409);
    }

    const scored = await Promise.all(
      activeParticipants.map(async (p) => ({
        participant: p,
        score: await scoreFn(p.userId, windowStart, existing.endsAt, tx),
      })),
    );

    const anyData = scored.some((s) => s.score.hasData);

    if (!anyData) {
      // Nobody cleared the coverage floor — there's no fair basis to
      // declare a winner, so refund everyone and cancel the pool.
      for (const s of scored) {
        await creditTokens(
          s.participant.userId,
          s.participant.entryFeePaid,
          'POOL_REFUND',
          `Pool "${existing.name}" cancelled — no verifiable screen-time data`,
          poolId,
          tx,
        );
        await tx.poolLedger.create({
          data: {
            poolId,
            type: 'REFUND' as PoolLedgerType,
            amount: s.participant.entryFeePaid,
            description: `Refund to ${s.participant.userId} — no verifiable data`,
          },
        });
        await tx.poolParticipant.update({ where: { id: s.participant.id }, data: { focusScore: 0 } });
      }

      const finalize = await tx.pool.updateMany({
        where: { id: poolId, status: 'SETTLING' as PoolStatus },
        data: { status: 'CANCELLED' as PoolStatus, settledAt: new Date() },
      });
      if (finalize.count === 0) {
        throw new AppError('Pool settlement conflict', 409);
      }
      return;
    }

    for (const s of scored) {
      await tx.poolParticipant.update({
        where: { id: s.participant.id },
        data: { focusScore: s.score.healthPercent },
      });
    }

    // Highest score wins; tie-break by earliest joinedAt for determinism.
    const ranked = [...scored].sort((a, b) =>
      b.score.healthPercent !== a.score.healthPercent
        ? b.score.healthPercent - a.score.healthPercent
        : a.participant.joinedAt.getTime() - b.participant.joinedAt.getTime(),
    );
    const winner = ranked[0].participant;

    const platformFee = Math.floor(existing.potTotal * PLATFORM_FEE_RATE);
    const winnerPayout = existing.potTotal - platformFee;

    await tx.poolParticipant.update({
      where: { id: winner.id },
      data: { tokensWon: winnerPayout },
    });

    await tx.poolLedger.createMany({
      data: [
        {
          poolId,
          type: 'PLATFORM_FEE' as PoolLedgerType,
          amount: platformFee,
          description: `Platform fee (${Math.round(PLATFORM_FEE_RATE * 100)}%)`,
        },
        {
          poolId,
          type: 'WINNING_PAYOUT' as PoolLedgerType,
          amount: winnerPayout,
          description: `Winner payout to ${winner.userId}`,
        },
      ],
    });

    await creditTokens(
      winner.userId,
      winnerPayout,
      'POOL_WIN',
      `Won pool "${existing.name}" (screen-time health score)`,
      poolId,
      tx,
    );

    const finalize = await tx.pool.updateMany({
      where: { id: poolId, status: 'SETTLING' as PoolStatus },
      data: { status: 'SETTLED' as PoolStatus, settledAt: new Date() },
    });
    if (finalize.count === 0) {
      throw new AppError('Pool settlement conflict', 409);
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
