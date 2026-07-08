import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { generalLimiter } from './middleware/rateLimiter.js';
import { errorHandler, requestIdMiddleware } from './middleware/errorHandler.js';
import { sanitizeInput } from './middleware/sanitize.js';
import { healthHandler } from './middleware/health.js';
import { docsJsonHandler, docsUiHandler } from './middleware/docs.js';

// Route modules — auth
import authRouter from './modules/auth/auth.routes.js';
import usersRouter from './modules/users/users.routes.js';
import friendsRouter from './modules/friends/friends.routes.js';

// Route modules — tokens
import tokensRouter from './modules/tokens/tokens.routes.js';

// Route modules — payments (Stripe)
import paymentsRouter from './modules/payments/payments.routes.js';
import { webhookHandler } from './modules/payments/payments.routes.js';

// Route modules — pools
import poolsRouter from './modules/pools/pools.routes.js';

// Route modules — wheel, power-ups, cosmetics, commitments
import wheelRouter from './modules/wheel/wheel.routes.js';
import powerupsRouter from './modules/powerups/powerups.routes.js';
import cosmeticsRouter from './modules/cosmetics/cosmetics.routes.js';
import commitmentsRouter from './modules/commitments/commitments.routes.js';

// Route modules — screen time
import screentimeRouter from './modules/screentime/screentime.routes.js';

// Route modules — devices (push notification tokens)
import devicesRouter from './modules/devices/devices.routes.js';

// Route modules — attestation (App Attest device integrity)
import attestationRouter from './modules/attestation/attestation.routes.js';

const app = express();

// Tell Express how many reverse-proxy hops sit in front of it so req.ip and
// X-Forwarded-For are resolved correctly — required for the rate limiters
// below to key off the real client IP instead of the proxy's IP (see
// env.ts's `trustProxyHops` docstring / CODE_REVIEW.md #11).
app.set('trust proxy', env.trustProxyHops);

// ─── Stripe webhook (must be BEFORE express.json() for raw body) ─────────────
// Gated by the same money-surface flag as payments/pools/commitments below —
// only mounted at all when the surface is live.

if (env.features.paymentsEnabled) {
  app.post(
    '/api/payments/webhook',
    express.raw({ type: 'application/json' }),
    webhookHandler
  );
}

// ─── Global Middleware ──────────────────────────────────────────────────────

app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL ?? 'https://apex-app.com')
    : '*',
  credentials: true,
}));
app.use(express.json({
  limit: '1mb',
  // Capture the exact request bytes before sanitizeInput can mutate req.body,
  // so attestation assertions can be bound to what the client actually sent.
  verify: (req, _res, buf) => { (req as express.Request).rawBody = Buffer.from(buf); },
}));
// Assign a request id before any other middleware runs so it's available
// everywhere — including the rate limiter's error path.
app.use(requestIdMiddleware);
app.use(generalLimiter);
// Sanitize all incoming strings after body parsing, before routes see them.
// Runs globally so every endpoint is protected without per-route wiring.
app.use(sanitizeInput);

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/health', healthHandler);

// ─── API Documentation ─────────────────────────────────────────────────────
// Public — no auth required. Serves the OpenAPI spec and an interactive UI.

app.get('/api/docs.json', docsJsonHandler);
app.get('/api/docs', docsUiHandler);

// ─── API Routes ─────────────────────────────────────────────────────────────

// ─── Auth & Users ─────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/friends', friendsRouter);

// ─── Tokens ───────────────────────────────────────────────────────────────
app.use('/api/tokens', tokensRouter);

// ─── Payments (Stripe), Pools, Commitments — real-money surfaces ──────────
// Gated by POOLS_PAYMENTS_ENABLED for Apple Guideline 5.3 compliance: the
// app can ship with money features fully off until compliance is resolved,
// and be flipped on cleanly. Disabled requests get a clear 503 rather than
// a generic 404.
const moneyDisabledHandler: express.RequestHandler = (_req, res) => {
  res.status(503).json({ error: 'This feature is temporarily disabled' });
};

if (env.features.paymentsEnabled) {
  app.use('/api/payments', paymentsRouter);
  app.use('/api/pools', poolsRouter);
  app.use('/api/commitments', commitmentsRouter);
} else {
  app.use('/api/payments', moneyDisabledHandler);
  app.use('/api/pools', moneyDisabledHandler);
  app.use('/api/commitments', moneyDisabledHandler);
}

// ─── Wheel, Power-Ups, Cosmetics ───────────────────────────────────────────
app.use('/api/wheel', wheelRouter);
app.use('/api/power-ups', powerupsRouter);
app.use('/api/cosmetics', cosmeticsRouter);

// ─── Screen Time ──────────────────────────────────────────────────────────
app.use('/api/screentime', screentimeRouter);

// ─── Devices (push notification tokens) ──────────────────────────────────
app.use('/api/devices', devicesRouter);

// ─── Attestation (App Attest device integrity) ────────────────────────────
// Doesn't move money itself, so it isn't behind the payments feature flag.
app.use('/api/attestation', attestationRouter);

// ─── 404 Handler ───────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global Error Handler ───────────────────────────────────────────────────

app.use(errorHandler);

export default app;
