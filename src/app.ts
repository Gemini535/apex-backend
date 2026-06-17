import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { generalLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';

// Route modules
import authRouter from './modules/auth/auth.routes.js';
import usersRouter from './modules/users/users.routes.js';
import friendsRouter from './modules/friends/friends.routes.js';
import paymentsRouter from './modules/payments/payments.routes.js';
import { webhookHandler } from './modules/payments/payments.routes.js';
import screentimeRouter from './modules/screentime/screentime.routes.js';

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
    ? ['https://apex-app.com']
    : '*',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(generalLimiter);

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes ─────────────────────────────────────────────────────────────

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/friends', friendsRouter);
app.use('/api', paymentsRouter); // /api/tokens/*, /api/pools/*, /api/payments/*
app.use('/api/screentime', screentimeRouter);

// ─── 404 Handler ───────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Global Error Handler ───────────────────────────────────────────────────

app.use(errorHandler);

export default app;
