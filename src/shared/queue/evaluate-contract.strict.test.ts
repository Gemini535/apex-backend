import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Verifies correction #3 from the attestation plan: enforcement mode must
 * NOT flip money-scoring to VERIFIED-only until 'strict'. 'flag' mode scores
 * off all data (identical to 'off'), so real users never lose a stake merely
 * because attestation is being trialed. Only 'strict' excludes unattested
 * data from the decision.
 *
 * Env vars must be set before config/env.ts is first evaluated, so every
 * import here is dynamic (see app.featureFlag.test.ts for the same pattern).
 */
describe('evaluate-contract — enforcement mode controls scoring data, not just upload acceptance', () => {
  let prisma: typeof import('../../config/database.js').prisma;
  let evaluateContract: typeof import('./evaluate-contract.js').evaluateContract;
  let createContract: typeof import('../../modules/commitments/commitments.service.js').createContract;
  let getBalance: typeof import('../../modules/tokens/tokens.service.js').getBalance;

  let userId: string;

  async function setup(mode: 'off' | 'flag' | 'strict') {
    process.env.ATTESTATION_ENFORCEMENT = mode;
    process.env.APPLE_APP_ATTEST_BUNDLE_ID = 'com.test.bundle';
    process.env.APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || 'TESTTEAMID';
    vi.resetModules();

    ({ prisma } = await import('../../config/database.js'));
    ({ evaluateContract } = await import('./evaluate-contract.js'));
    ({ createContract } = await import('../../modules/commitments/commitments.service.js'));
    ({ getBalance } = await import('../../modules/tokens/tokens.service.js'));
  }

  beforeAll(async () => {
    await setup('off');
    const u = await prisma.user.create({
      data: {
        email: `ec-strict-${Date.now()}@test.app`,
        username: `ec-strict-${Date.now()}`,
        passwordHash: 'fake',
        tokenWallet: { create: { balance: 100_000 } },
      },
    });
    userId = u.id;
  });

  afterAll(async () => {
    delete process.env.ATTESTATION_ENFORCEMENT;
    delete process.env.APPLE_APP_ATTEST_BUNDLE_ID;
    await prisma.tokenTransaction.deleteMany({ where: { wallet: { userId } } });
    await prisma.commitmentContract.deleteMany({ where: { userId } });
    await prisma.screenTimeEntry.deleteMany({ where: { userId } });
    await prisma.tokenWallet.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  async function seedUnattestedQualifyingData(startDate: Date, endDate: Date, target: number) {
    await prisma.screenTimeEntry.create({
      data: {
        userId,
        appName: 'Safari',
        category: 'PRODUCTIVITY',
        duration: target + 100,
        startedAt: new Date(startDate.getTime() + 1),
        // attestationStatus defaults to UNATTESTED — never verified.
      },
    });
  }

  it('flag mode still resolves COMPLETED from unattested data — attestation trialing must never cost a real stake', async () => {
    await setup('flag');
    const startDate = new Date(Date.now() - 1000);
    const endDate = new Date(Date.now() - 1);
    const target = 60;

    const contract = await createContract(userId, {
      name: 'Flag mode contract',
      pledgeAmountCents: 1000,
      targetScreenTime: target,
      startDate,
      endDate,
    });
    await seedUnattestedQualifyingData(startDate, endDate, target);

    const balanceBefore = (await getBalance(userId)).balance;
    const result = await evaluateContract(contract.id);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('COMPLETED');
    const balanceAfter = (await getBalance(userId)).balance;
    expect(balanceAfter).toBe(balanceBefore + 1000);
  });

  it('strict mode resolves FORFEITED from the same unattested data — only VERIFIED entries count once enforced', async () => {
    await setup('strict');
    const startDate = new Date(Date.now() - 1000);
    const endDate = new Date(Date.now() - 1);
    const target = 60;

    const contract = await createContract(userId, {
      name: 'Strict mode contract',
      pledgeAmountCents: 1000,
      targetScreenTime: target,
      startDate,
      endDate,
    });
    await seedUnattestedQualifyingData(startDate, endDate, target);

    const balanceBefore = (await getBalance(userId)).balance;
    const result = await evaluateContract(contract.id);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('FORFEITED');
    const balanceAfter = (await getBalance(userId)).balance;
    expect(balanceAfter).toBe(balanceBefore); // stake stays debited, no payout
  });
});
