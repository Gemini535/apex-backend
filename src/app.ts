import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { generalLimiter } from './middleware/rateLimiter.js';
import { errorHandler, requestIdMiddleware } from './middleware/errorHandler.js';
import { sanitizeInput } from './middleware/sanitize.js';
import { healthHandler } from './middleware/health.js';
import { docsJsonHandler, docsUiHandler } from './middleware/docs.js';

// Route modules
import authRouter from './modules/auth/auth.routes.js';
import usersRouter from './modules/users/users.routes.js';
import friendsRouter from './modules/friends/friends.routes.js';
import paymentsRouter from './modules/payments/payments.routes.js';
import { webhookHandler } from './modules/payments/payments.routes.js';
import screentimeRouter from './modules/screentime/screentime.routes.js';
import powerupsRouter from './modules/powerups/powerups.routes.js';

const app = express();

// ─── Stripe webhook (must be BEFORE express.json() for raw body) ─────────────

app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  webhookHandler
);

// ─── Global Middleware ──────────────────────────────────────────────────────

app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL ?? 'https://apex-app.com')
    : '*',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
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

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/friends', friendsRouter);
app.use('/api', paymentsRouter); // /api/tokens/*, /api/pools/*, /api/payments/*
app.use('/api/screentime', screentimeRouter);
app.use('/api', powerupsRouter); // /api/wheel/*, /api/power-ups/*, /api/cosmetics/*, /api/commitments/*

// ─── 404 Handler ───────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global Error Handler ───────────────────────────────────────────────────

app.use(errorHandler);

export default app;
