# Apex Backend

Backend for **Apex** — the hyper-gamified, social-accountability digital wellbeing
iOS app. Track screen time, keep friends accountable, stake tokens on your own
focus, and watch your brain avatar degrade (or thrive).

Built with **Node.js + TypeScript + Express + PostgreSQL (Prisma) + Socket.IO**.

---

## Features

| Area | What's here |
|---|---|
| **Auth** | Email/password, Apple & Google OAuth, TOTP/SMS/Email 2FA, refresh-token rotation, session management, password reset, email verification |
| **Users** | Profiles, brain state (tier + health from screen time), aggregated stats, search |
| **Friends** | Requests, accept/decline, block, real-time online presence over WebSocket |
| **Tokens & Payments** | Token wallet, transaction history, Stripe deposits & withdrawals (1¢ = 1 token) |
| **Pools** | Create/join/leave/settle cash pools with atomic transactions and an append-only audit ledger |
| **Screen Time** | Batch upload from device, daily/range summaries, per-app & per-category breakdowns |
| **Power-Ups & Cosmetics** | Token wheel (gacha), 6 power-ups, Cortex Vault cosmetics |
| **Commitment Contracts** | Self-imposed goal contracts with a token stake |
| **Real-time** | WebSocket broadcasts for brain state, friend presence, and screen time |

---

## Prerequisites

- **Node.js** 20+
- **PostgreSQL** 15+ running locally (or a connection string to a hosted instance)
- **npm** (comes with Node)

Optional, for the features that use them:
- Stripe account (for payments)
- Apple Developer account (for Sign-In)
- Google Cloud project (for Google OAuth)
- Twilio account (for SMS 2FA)
- SMTP server (for email 2FA & notifications)

---

## Local Setup

### 1. Clone and install

```bash
git clone <repo-url> my_app_backend
cd my_app_backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then edit `.env` and fill in the real values. The only **required** variables to
get started are `DATABASE_URL`, `JWT_SECRET`, and `JWT_REFRESH_SECRET`. Generate
the JWT secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Never commit `.env`.** It's in `.gitignore`. The `.env.example` file documents
> every variable with descriptions but no real values.

### 3. Set up the database

```bash
# Create the tables (uses Prisma's schema)
npx prisma db push

# Optional: generate the Prisma client explicitly
npm run prisma:generate

# Optional: seed test data
npm run prisma:seed
```

### 4. Start the server

```bash
# Development (auto-reload on file changes)
npm run dev

# Or build and run the compiled output
npm run build
npm start
```

The server starts on `http://localhost:3000` by default.

- **Health check:** http://localhost:3000/health
- **API docs (Swagger UI):** http://localhost:3000/api/docs
- **API docs (raw JSON):** http://localhost:3000/api/docs.json
- **WebSocket:** ws://localhost:3000

---

## Environment Variables

All configuration is via environment variables. See
[`.env.example`](./.env.example) for the full list with descriptions. The key
ones:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No (default 3000) | HTTP port |
| `NODE_ENV` | No (default `development`) | `development` / `production` / `test` |
| `JWT_SECRET` | Yes | Signs access tokens. ≥24 chars, not a placeholder. |
| `JWT_REFRESH_SECRET` | Yes | Signs refresh tokens. Must differ from `JWT_SECRET`. |
| `JWT_ACCESS_EXPIRY` | No (default `15m`) | Access token lifetime |
| `JWT_REFRESH_EXPIRY` | No (default `7d`) | Refresh token lifetime |
| `STRIPE_SECRET_KEY` | For payments | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | For payments | Stripe webhook signing secret |
| `APPLE_CLIENT_ID` | For Apple OAuth | Apple Sign-In service ID |
| `GOOGLE_CLIENT_ID` | For Google OAuth | Google OAuth client ID |
| `TWILIO_ACCOUNT_SID` | For SMS 2FA | Twilio account SID |
| `SMTP_HOST` | For email | SMTP server host |
| `RATE_LIMIT_WINDOW_MS` | No (default 900000) | General rate-limit window |
| `RATE_LIMIT_MAX` | No (default 100) | General rate-limit max requests |
| `FRONTEND_URL` | No | Production CORS origin |

---

## Running Tests

The test suite uses **Vitest** and runs against your configured database. Each
test file creates its own isolated data, so tests are safe to run against a
development database — but **do not run them against production**.

```bash
# Run all tests once
npm test

# Watch mode (re-run on file changes)
npm run test:watch

# With coverage report
npm run test:coverage
```

> Tests run sequentially (`fileParallelism: false`) to avoid parallel
> database-cleanup conflicts. A test database is recommended: set
> `DATABASE_URL` to a separate database (e.g. `apex_test`) before running.

---

## API Overview

All endpoints are prefixed with `/api`. Full request/response schemas are in the
[Swagger UI](http://localhost:3000/api/docs) — use that as the source of truth.
Quick reference:

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account |
| POST | `/auth/login` | — | Log in (may return 2FA challenge) |
| POST | `/auth/login/2fa` | — | Complete 2FA login |
| POST | `/auth/apple` | — | Apple Sign-In |
| POST | `/auth/google` | — | Google Sign-In |
| POST | `/auth/refresh` | — | Rotate refresh token |
| POST | `/auth/logout` | ✓ | Revoke session(s) |
| POST | `/auth/password/forgot` | — | Request password reset |
| POST | `/auth/password/reset` | — | Reset password with token |
| POST | `/auth/verify-email` | — | Verify email with token |
| GET | `/users/me` | ✓ | Current user profile |
| PATCH | `/users/me` | ✓ | Update profile |
| GET | `/users/search` | ✓ | Search users |
| GET | `/users/me/brain-state` | ✓ | Today's brain state |
| GET | `/users/me/stats` | ✓ | Aggregated stats |
| GET | `/users/:username` | ✓ | Public profile |
| POST | `/friends/request` | ✓ | Send friend request |
| POST | `/friends/accept` | ✓ | Accept request |
| POST | `/friends/decline` | ✓ | Decline request |
| DELETE | `/friends/:userId` | ✓ | Remove friend |
| POST | `/friends/block` | ✓ | Block user |
| DELETE | `/friends/block/:userId` | ✓ | Unblock user |
| GET | `/friends` | ✓ | List friends |
| GET | `/friends/requests/pending` | ✓ | Incoming requests |
| GET | `/friends/requests/sent` | ✓ | Sent requests |
| GET | `/tokens/balance` | ✓ | Token balance |
| GET | `/tokens/transactions` | ✓ | Transaction history |
| POST | `/payments/deposit` | ✓ | Deposit via Stripe |
| POST | `/payments/withdraw` | ✓ | Withdraw via Stripe |
| GET | `/payments/customer` | ✓ | Stripe customer |
| GET/POST | `/pools` | ✓ | List / create pools |
| GET | `/pools/:poolId` | ✓ | Pool details |
| POST | `/pools/:poolId/join` | ✓ | Join pool |
| POST | `/pools/:poolId/leave` | ✓ | Leave pool |
| POST | `/pools/:poolId/settle` | ✓ | Settle pool |
| GET | `/pools/:poolId/ledger` | ✓ | Pool ledger |
| POST | `/screentime/batch` | ✓ | Upload screen time |
| GET | `/screentime/today` | ✓ | Today's summary |
| GET | `/screentime/range` | ✓ | Date range |
| GET | `/screentime/apps` | ✓ | Per-app breakdown |
| GET | `/screentime/categories` | ✓ | Per-category breakdown |
| GET | `/screentime/active` | ✓ | Active session |
| POST | `/wheel/spin` | ✓ | Spin token wheel |
| GET | `/power-ups` | ✓ | List power-ups |
| POST | `/power-ups/activate` | ✓ | Activate power-up |
| GET | `/cosmetics` | ✓ | List cosmetics |
| POST | `/cosmetics/equip` | ✓ | Equip cosmetic |
| GET/POST | `/commitments` | ✓ | List / create contracts |
| POST | `/commitments/:id/cancel` | ✓ | Cancel contract |

---

## Production Readiness

This backend includes several production safeguards out of the box:

- **Rate limiting** — global limiter (configurable), strict auth limiter
  (5 req / 15 min) on login, password reset, and email verify, and a per-user
  wheel limiter (10 spins / min).
- **Input sanitization** — all incoming strings are stripped of HTML tags and
  trimmed globally before reaching any route handler.
- **Structured error logging** — every request gets a unique `x-request-id`
  (returned in the response header and all logs); errors log the request context
  with sensitive fields (passwords, tokens) automatically redacted.
- **Health check** — `/health` probes the database and returns `503` if it's
  unreachable, so load balancers can react.
- **Security headers** — Helmet sets sensible defaults.
- **JWT secret validation** — the server refuses to start with placeholder or
  too-short secrets, and requires the access and refresh secrets to differ.
- **CORS** — wide-open in development, locked to `FRONTEND_URL` in production.

---

## Project Structure

```
src/
├── app.ts                  # Express app: middleware, routes, error handler
├── server.ts               # HTTP + Socket.IO bootstrap, graceful shutdown
├── config/
│   ├── env.ts              # Validated environment variables
│   ├── database.ts         # Prisma client singleton
│   └── logger.ts           # Pino logger
├── middleware/
│   ├── auth.ts             # JWT verification
│   ├── errorHandler.ts     # Global error handler + AppError + request IDs
│   ├── health.ts           # DB-probing health check
│   ├── rateLimiter.ts      # General, auth, and wheel limiters
│   ├── sanitize.ts         # Global input sanitization
│   ├── validate.ts         # express-validator wrapper
│   └── docs.ts             # Swagger UI + OpenAPI JSON
├── modules/
│   ├── auth/               # Registration, login, 2FA, sessions, password reset
│   ├── users/              # Profiles, brain state, stats
│   ├── friends/            # Friend graph + blocking
│   ├── payments/           # Tokens, Stripe, pools
│   ├── powerups/           # Wheel, power-ups, cosmetics, contracts
│   └── screentime/         # Upload + aggregation
├── shared/
│   ├── brain-engine.ts     # Real-time brain state recalculation
│   ├── openapi.ts          # OpenAPI 3.0 spec
│   ├── types/              # Shared TypeScript interfaces
│   └── websocket/
│       └── socket.ts       # Socket.IO setup + presence
└── types/
    └── express.d.ts        # Express type augmentations
prisma/
├── schema.prisma           # Database schema
└── seed.ts                 # Test data seeder
```

---

## Tech Stack

- **Runtime:** Node.js 20+ with TypeScript (ESM)
- **HTTP:** Express 4
- **Database:** PostgreSQL via Prisma ORM
- **Real-time:** Socket.IO with JWT-authenticated connections
- **Auth:** JWT (access + refresh), bcrypt, TOTP (speakeasy), OAuth
- **Payments:** Stripe (PaymentIntent + webhooks)
- **Logging:** Pino
- **Testing:** Vitest + Supertest
