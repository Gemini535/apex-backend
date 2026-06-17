import Stripe from 'stripe';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import { creditTokens, debitTokens } from './tokens.service.js';

// ─── Stripe client ───────────────────────────────────────────────────────────

export const stripe = new Stripe(env.stripe.secretKey, {
  apiVersion: '2024-06-20',
});

// ─── Idempotency store (use Redis in production) ─────────────────────────────

interface IdempotencyEntry {
  status: 'pending' | 'completed' | 'failed';
  response?: unknown;
  error?: string;
  createdAt: number;
}

const idempotencyStore = new Map<string, IdempotencyEntry>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyStore.entries()) {
    if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
    }
  }
}, 60 * 60 * 1000); // every hour

async function checkIdempotency(key: string): Promise<IdempotencyEntry | null> {
  const entry = idempotencyStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > IDEMPOTENCY_TTL_MS) {
    idempotencyStore.delete(key);
    return null;
  }
  return entry;
}

function setIdempotency(key: string, entry: IdempotencyEntry): void {
  idempotencyStore.set(key, entry);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DepositResult {
  paymentIntentId: string;
  clientSecret: string;
  amount: number;
  currency: string;
}

export interface WithdrawResult {
  transferId: string;
  amount: number;
  currency: string;
  status: string;
}

// ─── Deposit: Create a Stripe PaymentIntent ──────────────────────────────────
// Flow: Client calls POST /api/payments/deposit → server creates PaymentIntent
// → client confirms with Stripe.js → Stripe sends webhook → server credits tokens

export async function createDeposit(
  userId: string,
  amountCents: number,
  idempotencyKey: string
): Promise<DepositResult> {
  // Check idempotency
  const existing = await checkIdempotency(idempotencyKey);
  if (existing) {
    if (existing.status === 'completed') {
      return existing.response as DepositResult;
    }
    if (existing.status === 'pending') {
      throw new AppError('A deposit with this idempotency key is already in progress', 409);
    }
    // 'failed' — allow retry
  }

  // Validate amount (min $1, max $500 per deposit)
  if (amountCents < 100) {
    throw new AppError('Minimum deposit is $1.00', 400);
  }
  if (amountCents > 50000) {
    throw new AppError('Maximum deposit is $500.00', 400);
  }

  setIdempotency(idempotencyKey, { status: 'pending', createdAt: Date.now() });

  try {
    // Get or create Stripe customer
    let paymentAccount = await prisma.paymentAccount.findUnique({
      where: { userId },
    });

    let stripeCustomerId: string;

    if (paymentAccount?.stripeCustomerId) {
      stripeCustomerId = paymentAccount.stripeCustomerId;
    } else {
      // Look up user email for the customer
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, username: true },
      });

      const customer = await stripe.customers.create({
        email: user.email,
        name: user.username,
        metadata: { userId },
      });

      stripeCustomerId = customer.id;

      paymentAccount = await prisma.paymentAccount.upsert({
        where: { userId },
        create: {
          userId,
          stripeCustomerId,
          paymentMethod: 'stripe',
        },
        update: {
          stripeCustomerId,
          paymentMethod: 'stripe',
        },
      });
    }

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',
        customer: stripeCustomerId,
        metadata: {
          userId,
          type: 'token_deposit',
          idempotencyKey,
        },
        description: `Apex token deposit (${amountCents} cents)`,
        automatic_payment_methods: { enabled: true },
      },
      {
        idempotencyKey, // Stripe-level idempotency
      }
    );

    const result: DepositResult = {
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret!,
      amount: amountCents,
      currency: 'usd',
    };

    setIdempotency(idempotencyKey, {
      status: 'completed',
      response: result,
      createdAt: Date.now(),
    });

    logger.info(
      { userId, amountCents, paymentIntentId: paymentIntent.id },
      'Deposit PaymentIntent created'
    );

    return result;
  } catch (err) {
    setIdempotency(idempotencyKey, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Unknown error',
      createdAt: Date.now(),
    });
    throw err;
  }
}

// ─── Confirm deposit: Called by webhook when payment succeeds ────────────────

export async function confirmDeposit(paymentIntentId: string): Promise<{
  userId: string;
  amountCents: number;
}> {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status !== 'succeeded') {
    throw new AppError(`PaymentIntent status is ${paymentIntent.status}, not succeeded`, 400);
  }

  const userId = paymentIntent.metadata.userId;
  const amountCents = paymentIntent.amount;

  if (!userId) {
    throw new AppError('No userId in PaymentIntent metadata', 400);
  }

  // Check if already processed (idempotency at our level)
  const existingTx = await prisma.tokenTransaction.findFirst({
    where: {
      referenceId: paymentIntentId,
      type: 'EARNED',
    },
  });

  if (existingTx) {
    logger.info({ paymentIntentId }, 'Deposit already processed, skipping');
    return { userId, amountCents };
  }

  // Credit tokens: 1 cent = 1 token (1:1 ratio)
  await creditTokens(
    userId,
    amountCents,
    'EARNED',
    `Stripe deposit: $${(amountCents / 100).toFixed(2)}`,
    paymentIntentId
  );

  logger.info({ userId, amountCents, paymentIntentId }, 'Deposit confirmed, tokens credited');

  return { userId, amountCents };
}

// ─── Withdraw: Transfer tokens to user's bank via Stripe Connect ─────────────

export async function createWithdrawal(
  userId: string,
  tokenAmount: number,
  idempotencyKey: string
): Promise<WithdrawResult> {
  // Check idempotency
  const existing = await checkIdempotency(idempotencyKey);
  if (existing) {
    if (existing.status === 'completed') {
      return existing.response as WithdrawResult;
    }
    if (existing.status === 'pending') {
      throw new AppError('A withdrawal with this idempotency key is already in progress', 409);
    }
  }

  // Validate amount (min 100 tokens = $1)
  if (tokenAmount < 100) {
    throw new AppError('Minimum withdrawal is 100 tokens ($1.00)', 400);
  }

  setIdempotency(idempotencyKey, { status: 'pending', createdAt: Date.now() });

  try {
    // Debit tokens first (inside its own transaction)
    await debitTokens(userId, tokenAmount, 'SPENT', 'Withdrawal to bank', idempotencyKey);

    // Note: Actual Stripe Connect transfer requires the user to have a connected
    // Stripe account. For now, we record the withdrawal and process it manually.
    // In production, you'd use stripe.transfers.create() with a connected account.

    const result: WithdrawResult = {
      transferId: `manual_${Date.now()}_${userId.slice(0, 8)}`,
      amount: tokenAmount,
      currency: 'usd',
      status: 'pending_manual_processing',
    };

    setIdempotency(idempotencyKey, {
      status: 'completed',
      response: result,
      createdAt: Date.now(),
    });

    logger.info({ userId, tokenAmount }, 'Withdrawal recorded for manual processing');

    return result;
  } catch (err) {
    setIdempotency(idempotencyKey, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Unknown error',
      createdAt: Date.now(),
    });
    throw err;
  }
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

export async function handleWebhook(
  payload: string | Buffer,
  signature: string
): Promise<{ received: boolean }> {
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      env.stripe.webhookSecret
    );
  } catch (err) {
    logger.error({ err }, 'Stripe webhook signature verification failed');
    throw new AppError('Webhook signature verification failed', 400);
  }

  logger.info({ type: event.type, id: event.id }, 'Stripe webhook received');

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (paymentIntent.metadata.type === 'token_deposit') {
        await confirmDeposit(paymentIntent.id);
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      logger.warn(
        { paymentIntentId: paymentIntent.id },
        'Stripe payment failed'
      );
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      logger.info(
        { chargeId: charge.id, amountRefunded: charge.amount_refunded },
        'Stripe charge refunded'
      );
      // TODO: Handle refund — reverse tokens if needed
      break;
    }

    default:
      logger.debug({ type: event.type }, 'Unhandled Stripe webhook event type');
  }

  return { received: true };
}

// ─── Get or create Stripe customer ID ────────────────────────────────────────

export async function getStripeCustomerId(userId: string): Promise<string | null> {
  const account = await prisma.paymentAccount.findUnique({
    where: { userId },
  });
  return account?.stripeCustomerId ?? null;
}
