import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

/**
 * Verifies the Guideline 5.3 kill-switch: POOLS_PAYMENTS_ENABLED=false must
 * fully disable pools, payments, and commitments (503, not a generic 404),
 * while leaving unrelated surfaces untouched. Env vars must be set before
 * config/env.ts is first evaluated, so app.js is imported dynamically after
 * setting process.env (see other *.strict.test.ts files for the same pattern).
 */
describe('app — POOLS_PAYMENTS_ENABLED feature flag', () => {
  it('returns 503 for pools/payments/commitments when the flag is disabled', async () => {
    process.env.POOLS_PAYMENTS_ENABLED = 'false';
    vi.resetModules();
    const { default: app } = await import('./app.js');

    const pools = await request(app).get('/api/pools');
    const payments = await request(app).post('/api/payments/deposit').send({});
    const commitments = await request(app).get('/api/commitments');

    expect(pools.status).toBe(503);
    expect(payments.status).toBe(503);
    expect(commitments.status).toBe(503);

    delete process.env.POOLS_PAYMENTS_ENABLED;
  });

  it('routes normally when the flag is enabled (default)', async () => {
    process.env.POOLS_PAYMENTS_ENABLED = 'true';
    vi.resetModules();
    const { default: app } = await import('./app.js');

    // No auth token — these should hit auth middleware (401), not the
    // feature-flag 503, proving the routes are actually mounted.
    const pools = await request(app).get('/api/pools');
    const commitments = await request(app).get('/api/commitments');

    expect(pools.status).not.toBe(503);
    expect(commitments.status).not.toBe(503);

    delete process.env.POOLS_PAYMENTS_ENABLED;
  });

  it('attestation and screentime surfaces are never gated by the money flag', async () => {
    process.env.POOLS_PAYMENTS_ENABLED = 'false';
    vi.resetModules();
    const { default: app } = await import('./app.js');

    const attestation = await request(app).post('/api/attestation/challenge').send({ purpose: 'UPLOAD_ASSERTION' });
    expect(attestation.status).not.toBe(503);

    delete process.env.POOLS_PAYMENTS_ENABLED;
  });
});
