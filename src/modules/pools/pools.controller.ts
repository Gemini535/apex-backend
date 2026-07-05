import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import { createPool, joinPool, leavePool, getPool, listPools, settlePool, getPoolLedger } from './pools.service.js';

export async function createPoolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, description, entryFee, maxParticipants, endsAt } = req.body;
    const pool = await createPool(req.user!.userId, name, description, entryFee, maxParticipants, new Date(endsAt));
    res.status(201).json(pool);
  } catch (err) {
    next(err);
  }
}

export async function joinPoolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await joinPool(req.params.poolId, req.user!.userId));
  } catch (err) {
    next(err);
  }
}

export async function leavePoolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await leavePool(req.params.poolId, req.user!.userId));
  } catch (err) {
    next(err);
  }
}

export async function getPoolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getPool(req.params.poolId));
  } catch (err) {
    next(err);
  }
}

export async function listPoolsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json(await listPools(status, page, limit));
  } catch (err) {
    next(err);
  }
}

export async function settlePoolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;

    // The outcome is now fully data-derived from real participant activity
    // (see settlePool) rather than a client-supplied "winnerUserId", so
    // there's no fraud risk in *who* triggers settlement — only an
    // authorization concern that a random third party shouldn't be able to.
    // Allow the creator or any (past or present) participant to trigger it,
    // so a pool isn't stranded forever if the creator goes AWOL.
    const pool = await getPool(req.params.poolId);
    const isCreator = pool.creatorId === userId;
    const isParticipant = pool.participants.some((p) => p.userId === userId);
    if (!isCreator && !isParticipant) {
      throw new AppError('Only the pool creator or a participant can settle the pool', 403);
    }

    res.json(await settlePool(req.params.poolId));
  } catch (err) {
    next(err);
  }
}

export async function getPoolLedgerHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getPoolLedger(req.params.poolId));
  } catch (err) {
    next(err);
  }
}
