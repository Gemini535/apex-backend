# Deploy Checklist: Apex Backend (Express + Prisma + Railway)

**Date:** 2026-07-07 | **Stack:** Node 20 + Express + Prisma/Postgres + pg-boss | **Target:** Railway

Status legend: ✅ done · ⬜ to do

---

## 1. Code — ✅ ready, needs commit

- ✅ Typecheck passes (`npx tsc --noEmit`)
- ✅ Security hardening pass landed (JWT alg pinning, per-session revocation, atomic wallet UPDATEs, settlement lock, idempotency keys user-scoped, trust-proxy configured)
- ✅ NEW (this session, uncommitted):
  - `tsconfig.json` — pinned `typeRoots` so `tsc` no longer picks up the parent Next.js folder's broken `@types` packages
  - `package.json` — `main` corrected to `dist/src/server.js` (matches Procfile/railway.toml)
  - `stripe.service.ts` — webhook `event.id` dedupe + refund reversal now delta-based (fixes double-debit on duplicate `charge.refunded` deliveries and over-clawback on partial refunds)
- ⬜ **Commit & push** the above + the untracked `.github/workflows/ci.yml`:
  ```bash
  cd apex-backend
  git add tsconfig.json package.json src/modules/payments/stripe.service.ts .github/
  git commit -m "Webhook dedupe + delta refund reversal; fix typeRoots and main entry"
  git push origin main
  ```
- ⬜ **Verify CI goes green** on GitHub (first run of the new pipeline: typecheck, build, full Vitest suite against Postgres). The suite could not run locally in this sandbox (no DB access) — CI is the gate.

## 2. Infrastructure — ⬜

- ⬜ Create Railway project, connect the `Gemini535/apex-backend` GitHub repo (railway.toml + Procfile already in repo)
- ⬜ Add Railway Postgres plugin (provides `DATABASE_URL`) — or point `DATABASE_URL` at the existing Neon DB
- ⬜ Run production migrations against the prod DB:
  ```bash
  npx prisma migrate deploy   # applies 3 migrations: init, session revocation, missing tables
  ```
- ⬜ Seed reference data if needed: `npm run prisma:seed`

## 3. Environment variables (Railway dashboard) — ⬜

Required (startup fails or is unsafe without these):
- ⬜ `DATABASE_URL` — prod Postgres
- ⬜ `JWT_SECRET` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- ⬜ `JWT_REFRESH_SECRET` — different value, same command (startup enforces ≥24 chars, non-placeholder, distinct)
- ⬜ `STRIPE_SECRET_KEY` — `sk_live_...`
- ⬜ `STRIPE_WEBHOOK_SECRET` — from the webhook endpoint created in step 4
- ⬜ `FRONTEND_URL` — production frontend origin (CORS locks to this in prod)
- ⬜ `NODE_ENV=production`

Optional (features degrade gracefully): Twilio (SMS 2FA), SMTP (email), Apple/Google OAuth creds, APNs (`APN_KEY_ID`, `APN_TEAM_ID`, `APN_BUNDLE_ID`, `APN_KEY_PATH`, `APN_PRODUCTION=true`), `TRUST_PROXY_HOPS` (defaults to 1 in prod — correct for Railway), `RATE_LIMIT_*`.

## 4. Stripe — ⬜

- ⬜ Switch dashboard to live mode; get live keys
- ⬜ Register webhook endpoint: `https://<railway-domain>/api/payments/webhook`
  - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`
- ⬜ Copy the endpoint's `whsec_...` into `STRIPE_WEBHOOK_SECRET`
- ⬜ Stripe Connect must be enabled on the account (Express accounts): withdrawals use `stripe.transfers.create` to connected accounts. Onboarding endpoints now exist — `POST /api/payments/connect/onboarding` returns a hosted onboarding URL the client opens in a browser; `GET /api/payments/connect/status` reports payout readiness. The iOS client must call these before offering withdrawal.
- ⬜ Host simple `/connect/return` and `/connect/refresh` pages at `FRONTEND_URL` (Stripe redirects there after onboarding; they can just say "return to the Apex app")
- ⬜ Test end-to-end with Stripe CLI before go-live: `stripe trigger payment_intent.succeeded`

## 5. Post-deploy verification — ⬜

- ⬜ `GET https://<railway-domain>/health` returns 200 (Railway healthcheck is wired to this, 300s timeout)
- ⬜ Register a test user → login → `GET /api/tokens/balance`
- ⬜ Small live deposit ($1) → confirm webhook credits tokens → refund it → confirm tokens clawed back exactly once
- ⬜ Check logs (pino) for startup warnings — a test-mode Stripe key in production logs a warning
- ⬜ Confirm rate limiting works from a real client IP (429 after limit), which proves trust-proxy is right

## 6. Rollback plan

- Railway: redeploy previous build from the deployments tab (restartPolicy already `on_failure`, max 10 retries)
- Migrations in this release are additive-only → no down-migration needed
- Trigger: `/health` failing, webhook 4xx/5xx spike in Stripe dashboard, or wallet-balance anomalies in `TokenTransaction`

---

## Frontend (apex-web, outer folder) — separate deploy, has pending work

- ⬜ Uncommitted hardening changes (billing webhook dedupe, ping rate-limit fix, friends/journal/parties fixes) + untracked `supabase/migrations/005_webhook_dedupe_and_ping_rate_limit.sql` → commit, run migration 005 in Supabase SQL editor, then deploy on Vercel
- See `../DEPLOY_CHECKLIST.md` for the full Vercel/Supabase checklist (env vars, auth providers, Stripe subscription webhook)

## Known gaps (non-blocking, tracked)

1. `confirmDeposit` dedupe is read-then-write (no unique index on `TokenTransaction.referenceId+type`); two *simultaneous* duplicate webhook deliveries could theoretically double-credit. Consider a partial unique index later.
2. `STRIPE_WEBHOOK_SECRET` placeholder only triggers a warning path for the secret key, not the webhook secret — a placeholder webhook secret in prod would make all webhooks fail signature verification (fail-closed, so safe, but confusing).
3. Refund reversal when the user already spent the tokens logs for manual reconciliation — decide an ops process for negative-balance recovery.
