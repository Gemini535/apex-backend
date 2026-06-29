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
| **Tokens** | Wallet balance, transaction history |
| **Payments** | Stripe deposits & withdrawals (1¢ = 1 token), real Stripe Connect payouts |
| **Pools** | Create/join/leave/settle cash pools with atomic transactions and an append-only audit ledger |
| **Screen Time** | Batch upload from device, daily/range summaries, per-app & per-category breakdowns, timezone-aware day boundaries |
| **Wheel** | Token wheel (gacha) with weighted drops |
| **Power-Ups** | 6 power-ups, inventory + activation |
| **Cosmetics** | Cortex Vault cosmetics, equip |
| **Commitment Contracts** | Self-imposed goal contracts with a token stake, hourly resolution job |
| **Push Notifications** | iOS push via APNs (.p8 token auth) for brain updates, friend activity, contract outcomes, and threshold alerts |
| **Real-time** | WebSocket broadcasts for brain state, friend presence, and screen time |
| **Job Queue** | pg-boss (Postgres-backed) for brain recalc, streak decay, contract resolution, cache cleanup |
| **Cache** | In-memory LRU cache for brain state, friend lists, and token balances |

---

## Prerequisites

- **Node.js** 20+
- **PostgreSQL** 15+ running locally (or a connection string to a hosted instance)
- **npm** (comes with Node)

Optional, for the features that use them:
- Stripe account (for payments)
- Apple Developer account (for Sign-In)
- Apple Developer account with APNs Auth Key (for push notifications)
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
| `APN_KEY_ID` | For push notifications | APNs auth key ID (10 chars) |
| `APN_TEAM_ID` | For push notifications | Apple Developer Team ID |
| `APN_BUNDLE_ID` | For push notifications | App bundle ID (default `com.apex.app`) |
| `APN_KEY_PATH` | For push notifications | Path to the .p8 private key file |
| `APN_PRODUCTION` | No (default `false`) | `true` for production APNs, `false` for sandbox |
| `RATE_LIMIT_WINDOW_MS` | No (default 900000) | General rate-limit window |
| `RATE_LIMIT_MAX` | No (default 100) | General rate-limit max requests |
| `FRONTEND_URL` | No | Production CORS origin |
| `CONTRACT_GOAL_THRESHOLD` | No (default `0.6`) | Fraction of days a user must hit their target to pass a commitment |

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
| POST | `/devices/register` | ✓ | Register a push notification device token |
| GET | `/devices` | ✓ | List registered devices |
| PUT | `/devices` | ✓ | Update a device token |
| DELETE | `/devices/:token` | ✓ | Unregister a device |

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
- **Durable caching** — SMS/email codes and Stripe idempotency keys persist in
  Postgres, surviving restarts and working across horizontally scaled instances.

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
│   ├── auth.test.ts        # Auth middleware tests
│   ├── docs.ts             # Swagger UI + OpenAPI JSON
│   ├── errorHandler.ts     # Global error handler + AppError + request IDs
│   ├── health.ts           # DB-probing health check
│   ├── rateLimiter.ts      # General, auth, and wheel limiters
│   ├── sanitize.ts         # Global input sanitization
│   └── validate.ts         # express-validator wrapper
├── modules/
│   ├── auth/               # Registration, login, 2FA, sessions, password reset
│   ├── users/              # Profiles, brain state, stats, streaks
│   ├── friends/            # Friend graph + blocking
│   ├── tokens/             # Wallet balance, transaction history
│   ├── payments/           # Stripe deposits, withdrawals, webhooks
│   ├── pools/              # Cash pools: create, join, settle, ledger
│   ├── wheel/              # Token wheel (gacha)
│   ├── powerups/           # Power-up inventory + activation
│   ├── cosmetics/          # Cortex Vault cosmetics
│   ├── commitments/        # Commitment contracts with stakes
│   ├── devices/            # Push notification device token registration
│   ├── notifications/      # APNs push notification sender
│   └── screentime/         # Upload + aggregation
├── shared/
│   ├── brain-engine.ts     # Real-time brain state recalculation
│   ├── events.ts           # Typed internal event emitter
│   ├── events.listeners.ts # Side-effect listeners (WebSocket, push, streak)
│   ├── openapi.ts          # OpenAPI 3.0 spec
│   ├── tz.ts               # Timezone-aware day boundaries
│   ├── cache/
│   │   ├── store.ts        # Generic LRU+TTL cache
│   │   ├── durable.ts      # Postgres-backed durable cache (KV + cleanup)
│   │   ├── brainState.ts   # Brain state cache
│   │   ├── friends.ts      # Friend list cache
│   │   ├── balance.ts      # Token balance cache
│   │   └── index.ts        # Cache barrel export
│   ├── queue/
│   │   ├── boss.ts         # pg-boss singleton + startup
│   │   ├── jobs.ts         # Job name constants + payload types
│   │   ├── handlers.ts     # Job handlers
│   │   ├── evaluate-contract.ts  # Single-contract resolution logic
│   │   └── evaluate-contract.test.ts
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
- **Payments:** Stripe (PaymentIntent + webhooks + Connect payouts)
- **Push Notifications:** APNs via HTTP/2 with .p8 token-based auth
- **Job Queue:** pg-boss (Postgres-backed, no Redis)
- **Cache:** In-memory LRU + Postgres-backed durable KV
- **Logging:** Pino
- **Testing:** Vitest + Supertest
