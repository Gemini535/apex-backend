import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Verifies the money-surface kill-switch also stops the hourly contract-
 * resolution cron from running, not just the HTTP routes — otherwise
 * disabling payments would still let contracts stake/forfeit tokens in the
 * background. pg-boss itself is mocked (no real Postgres queue needed);
 * env vars must be set before config/env.ts first evaluates, so imports are
 * dynamic.
 */
describe('boss — CONTRACT_RESOLVE_ALL cron gating', () => {
  afterEach(() => {
    delete process.env.POOLS_PAYMENTS_ENABLED;
    delete process.env.NODE_ENV;
    vi.doUnmock('pg-boss');
  });

  async function startWithMockedBoss() {
    const scheduleCalls: unknown[][] = [];
    const subscribeCalls: unknown[][] = [];

    vi.doMock('pg-boss', () => ({
      default: class MockPgBoss {
        on() {}
        async start() { return this; }
        async subscribe(...args: unknown[]) { subscribeCalls.push(args); }
        async schedule(...args: unknown[]) { scheduleCalls.push(args); }
        async stop() {}
      },
    }));

    vi.resetModules();
    const { startBoss } = await import('./boss.js');
    await startBoss();
    return { scheduleCalls, subscribeCalls };
  }

  it('does not schedule the contract-resolution cron when the money surface is disabled', async () => {
    process.env.NODE_ENV = 'production'; // bypass the existing test-env schedule guard
    process.env.POOLS_PAYMENTS_ENABLED = 'false';

    const { scheduleCalls } = await startWithMockedBoss();
    const { JOBS } = await import('./jobs.js');

    const contractSchedule = scheduleCalls.find((args) => args[0] === JOBS.CONTRACT_RESOLVE_ALL);
    expect(contractSchedule).toBeUndefined();
  });

  it('schedules the contract-resolution cron when the money surface is enabled', async () => {
    process.env.NODE_ENV = 'production';
    process.env.POOLS_PAYMENTS_ENABLED = 'true';

    const { scheduleCalls } = await startWithMockedBoss();
    const { JOBS } = await import('./jobs.js');

    const contractSchedule = scheduleCalls.find((args) => args[0] === JOBS.CONTRACT_RESOLVE_ALL);
    expect(contractSchedule).toBeDefined();
  });
});
