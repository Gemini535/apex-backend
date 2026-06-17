import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import { getBalance, getTransactions } from './tokens.service.js';
import { createPool, joinPool, leavePool, getPool, listPools, settlePool, getPoolLedger } from './pools.service.js';
import {
  createDeposit,
  createWithdrawal,
  handleWebhook,
  getStripeCustomerId,
} from './stripe.service.js';

// ─── Token balance ───────────────────────────────────────────────────────────

export async function getBalanceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getBalance(req.user!.userId));
  } catch (err) {
    next(err);
  }
}

export async function getTransactionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json(await getTransactions(req.user!.userId, page, limit));
  } catch (err) {
    next(err);
  }
}

// ─── Stripe deposit ───────────────────────────────────────────────────────────

export async function depositHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { amount, idempotencyKey } = req.body as {
      amount: number;       // amount in cents
      idempotencyKey: string;
    };

    if (!amount || typeof amount !== 'number') {
      throw new AppError('amount (in cents) is required', 400);
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new AppError('idempotencyKey is required to prevent duplicate charges', 400);
    }

    const result = await createDeposit(req.user!.userId, amount, idempotencyKey);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Stripe withdrawal ───────────────────────────────────────────────────────

export async function withdrawHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { amount, idempotencyKey } = req.body as {
      amount: number;       // token amount
      idempotencyKey: string;
    };

    if (!amount || typeof amount !== 'number') {
      throw new AppError('amount (in tokens) is required', 400);
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new AppError('idempotencyKey is required to prevent duplicate withdrawals', 400);
    }

    const result = await createWithdrawal(req.user!.userId, amount, idempotencyKey);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Stripe webhook ──────────────────────────────────────────────────────────

export async function webhookHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      throw new AppError('Missing stripe-signature header', 400);
    }

    // req.body must be raw Buffer for signature verification
    const payload = req.body as string | Buffer;
    const result = await handleWebhook(payload, signature);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Stripe customer info ────────────────────────────────────────────────────

export async function getCustomerHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const customerId = await getStripeCustomerId(req.user!.userId);
    res.json({ stripeCustomerId: customerId });
  } catch (err) {
    next(err);
  }
}

// ─── Pool endpoints ──────────────────────────────────────────────────────────

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
    const { winnerUserId } = req.body;
    if (!winnerUserId) throw new AppError('winnerUserId is required', 400);

    // Verify the caller is the pool creator
    const pool = await getPool(req.params.poolId);
    if (pool.creatorId !== userId) {
      throw new AppError('Only the pool creator can settle the pool', 403);
    }

    res.json(await settlePool(req.params.poolId, winnerUserId));
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
