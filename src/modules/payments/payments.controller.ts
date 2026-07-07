import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import {
  createDeposit,
  createWithdrawal,
  handleWebhook,
  getStripeCustomerId,
  createConnectOnboarding,
  getConnectStatus,
} from './stripe.service.js';

// ─── Stripe deposit ──────────────────────────────────────────────────────────

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

// ─── Stripe withdrawal ──────────────────────────────────────────────────────

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

// ─── Stripe Connect onboarding (required before withdrawals) ─────────────────

export async function connectOnboardingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await createConnectOnboarding(req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function connectStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await getConnectStatus(req.user!.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
