import Stripe from 'stripe';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../middleware/errorHandler.js';
import { creditTokens, debitTokens } from '../tokens/tokens.service.js';
import { cacheGet, cacheSet } from '../../shared/cache/durable.js';

// ─── Stripe client ───────────────────────────────────────────────────────────

export const stripe = new Stripe(env.stripe.secretKey, {
  apiVersion: '2024-06-20',
});

// ─── Idempotency store (Postgres-backed) ─────────────────────────────────────

interface IdempotencyEntry {
  status: 'pending' | 'completed' | 'failed';
  response?: unknown;
  error?: string;
  createdAt: number;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IDEMPOTENCY_PREFIX = 'stripe:';

/**
 * Namespaces the cache key by `userId` in addition to the client-supplied
 * idempotency key. Previously the key was just `stripe:${idempotencyKey}`
 * with no user scoping — if two different users' clients ever submitted the
 * same idempotency key (a buggy client reusing one, or a malicious user
 * deliberately guessing/reusing someone else's), `createDeposit` would
 * return the OTHER user's cached PaymentIntent — including its
 * `clientSecret` — to the wrong caller, a cross-tenant secret leak
 * (CODE_REVIEW.md #9).
 */
function idempotencyCacheKey(userId: string, idempotencyKey: string): string {
  return `${IDEMPOTENCY_PREFIX}${userId}:${idempotencyKey}`;
}

async function checkIdempotency(userId: string, key: string): Promise<IdempotencyEntry | null> {
  const entry = await cacheGet<IdempotencyEntry>(idempotencyCacheKey(userId, key));
  if (!entry) return null;
  if (Date.now() - entry.createdAt > IDEMPOTENCY_TTL_MS) {
    return null;
  }
  return entry;
}

async function setIdempotency(userId: string, key: string, entry: IdempotencyEntry): Promise<void> {
  await cacheSet(idempotencyCacheKey(userId, key), entry, IDEMPOTENCY_TTL_MS);
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
  const existing = await checkIdempotency(userId, idempotencyKey);
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

  await setIdempotency(userId, idempotencyKey, { status: 'pending', createdAt: Date.now() });

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

    await setIdempotency(userId, idempotencyKey, {
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
    await setIdempotency(userId, idempotencyKey, {
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
  const existing = await checkIdempotency(userId, idempotencyKey);
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

  await setIdempotency(userId, idempotencyKey, { status: 'pending', createdAt: Date.now() });

  try {
    // Debit tokens first (inside its own transaction). This ensures the user
    // can't double-spend while the payout is in flight.
    await debitTokens(userId, tokenAmount, 'SPENT', 'Withdrawal to bank', idempotencyKey);

    // Look up the user's connected Stripe account. Without one, the payout
    // cannot be sent — surface a clear error instead of silently failing.
    const paymentAccount = await prisma.paymentAccount.findUnique({
      where: { userId },
    });

    if (!paymentAccount?.stripeConnectedAccountId) {
      throw new AppError(
        'No connected Stripe account. Complete onboarding before withdrawing.',
        400,
      );
    }

    // Create a real Stripe Connect transfer to the user's connected account.
    // The amount is in cents (1 token = 1 cent). The transfer is denominated in
    // the same currency as the Stripe account (typically usd).
    const transfer = await stripe.transfers.create(
      {
        amount: tokenAmount,
        currency: 'usd',
        destination: paymentAccount.stripeConnectedAccountId,
        metadata: {
          userId,
          tokenAmount: String(tokenAmount),
          idempotencyKey,
        },
      },
      { idempotencyKey },
    );

    const result: WithdrawResult = {
      transferId: transfer.id,
      amount: tokenAmount,
      currency: 'usd',
      status: 'pending',
    };

    await setIdempotency(userId, idempotencyKey, {
      status: 'completed',
      response: result,
      createdAt: Date.now(),
    });

    logger.info(
      { userId, tokenAmount, transferId: transfer.id },
      'Withdrawal sent via Stripe Connect',
    );

    return result;
  } catch (err) {
    await setIdempotency(userId, idempotencyKey, {
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

  // Event-level dedupe. Stripe delivers webhooks at-least-once, and a
  // duplicate delivery of a money-moving event (charge.refunded in
  // particular) must not run its side effects twice. `confirmDeposit` is
  // internally idempotent, but the refund-reversal path below debits a
  // wallet, so we short-circuit any event id we've already fully processed.
  // (Best-effort: the marker is written after processing succeeds, so a
  // crash mid-event still lets Stripe's retry through — which is what we
  // want. The per-charge delta arithmetic below is the hard guarantee.)
  const eventCacheKey = `stripe:event:${event.id}`;
  const alreadyProcessed = await cacheGet<boolean>(eventCacheKey);
  if (alreadyProcessed) {
    logger.info({ id: event.id, type: event.type }, 'Duplicate Stripe event, skipping');
    return { received: true };
  }

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

      // The charge may be linked to a token deposit via our metadata. If so,
      // reverse the tokens that were credited for this charge — the user is
      // getting their money back, so the tokens must be clawed back.
      const paymentIntentId = charge.payment_intent as string | null;
      if (paymentIntentId) {
        const tx = await prisma.tokenTransaction.findFirst({
          where: { referenceId: paymentIntentId, type: 'EARNED' },
        });

        if (tx) {
          const wallet = await prisma.tokenWallet.findUnique({ where: { id: tx.walletId } });

          if (wallet) {
            try {
              // Reverse only the DELTA still owed for this charge, capped at
              // the original credit. `charge.refunded` fires once per refund
              // (partial refunds each fire it, with a cumulative
              // `amount_refunded`), and Stripe may also redeliver the same
              // event. The old code debited the FULL original credit on
              // every delivery — a duplicate delivery or a partial refund
              // clawed back more tokens than the user was ever credited.
              const originalCredit = Math.abs(tx.amount);
              const reversals = await prisma.tokenTransaction.aggregate({
                where: { walletId: tx.walletId, referenceId: charge.id, type: 'SPENT' },
                _sum: { amount: true },
              });
              const alreadyReversed = Math.abs(reversals._sum.amount ?? 0);
              const targetReversal = Math.min(charge.amount_refunded, originalCredit);
              const delta = targetReversal - alreadyReversed;

              if (delta <= 0) {
                logger.info(
                  { chargeId: charge.id, alreadyReversed, targetReversal },
                  'Refund already fully reversed, skipping',
                );
                break;
              }

              await debitTokens(
                wallet.userId,
                delta,
                'SPENT',
                `Refund reversal for charge ${charge.id}`,
                charge.id,
              );
              logger.info(
                { chargeId: charge.id, userId: wallet.userId, amount: delta },
                'Tokens reversed for refunded charge',
              );
            } catch (err) {
              // The user may have already spent the tokens before the
              // refund arrived, so the debit can legitimately fail with
              // "insufficient balance" — there's no way to claw back tokens
              // that no longer exist, and retrying this webhook won't
              // change that. Previously this error propagated uncaught,
              // causing Stripe to receive a 500 and retry indefinitely with
              // no path to resolution and no distinct signal for
              // operators to act on (CODE_REVIEW.md #20). Log loudly for
              // manual reconciliation instead, and still acknowledge the
              // webhook below — Stripe's refund already happened
              // regardless of whether we could reverse the tokens.
              logger.error(
                { err, chargeId: charge.id, userId: wallet.userId, amount: Math.abs(tx.amount) },
                'Failed to reverse tokens for refunded charge — likely already spent by the user; needs manual reconciliation',
              );
            }
          }
        }
      } else {
        logger.info(
          { chargeId: charge.id, amountRefunded: charge.amount_refunded },
          'Stripe charge refunded (no linked transaction to reverse)',
        );
      }
      break;
    }

    default:
      logger.debug({ type: event.type }, 'Unhandled Stripe webhook event type');
  }

  // Mark the event as processed only after all side effects succeeded, so a
  // crash mid-processing leaves the marker unset and Stripe's retry can
  // complete the work.
  await cacheSet(eventCacheKey, true, IDEMPOTENCY_TTL_MS);

  return { received: true };
}

// ─── Get or create Stripe customer ID ────────────────────────────────────────

export async function getStripeCustomerId(userId: string): Promise<string | null> {
  const account = await prisma.paymentAccount.findUnique({
    where: { userId },
  });
  return account?.stripeCustomerId ?? null;
}
