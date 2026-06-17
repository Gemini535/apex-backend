import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { creditTokens } from '../payments/tokens.service.js';
import type { PowerUpType } from '@prisma/client';

// ─── Token Wheel (Gacha) ─────────────────────────────────────────────────────

const WHEEL_COST = 10; // tokens per spin
const BASELINE_CREDIT_REWARD = 15; // minimum tokens earned per spin

/** The 6 power-ups that can drop from the wheel, with their rarity weights. */
const POWER_UP_DROPS: { type: PowerUpType; weight: number }[] = [
  { type: 'INHALE_ASSIST', weight: 30 },    // most common — small convenience
  { type: 'BS', weight: 25 },               // common — informational
  { type: 'SLIME_SHIELD', weight: 20 },     // uncommon — defensive
  { type: 'DOUBLE_DOWN', weight: 10 },      // rare — high risk/reward
  { type: 'BS_PLUS', weight: 8 },           // rare — upgraded informational
  { type: 'BOUNTY', weight: 7 },            // rarest — offensive PvP
];

/** Cosmetic drops (simplified — in production, these come from the DB). */
const COSMETIC_DROPS = [
  { name: 'Retro Headphones', type: 'HEADPHONES' as const, rarity: 'COMMON' as const },
  { name: 'Tiny Coffee Cup', type: 'COFFEE_CUP' as const, rarity: 'COMMON' as const },
  { name: 'Cyber Shades', type: 'GLASSES' as const, rarity: 'RARE' as const },
  { name: 'Neon Beanie', type: 'HAT' as const, rarity: 'RARE' as const },
  { name: 'Golden Crown', type: 'HAT' as const, rarity: 'LEGENDARY' as const },
];

export interface WheelSpinResult {
  rewardType: 'credits' | 'power_up' | 'cosmetic';
  credits: number;
  powerUp?: {
    type: PowerUpType;
    description: string;
  };
  cosmetic?: {
    name: string;
    type: string;
    rarity: string;
  };
}

/**
 * Spin the token wheel. Costs 10 tokens, guarantees at least 15 tokens back.
 * May also drop a power-up or cosmetic item.
 */
export async function spinWheel(userId: string): Promise<WheelSpinResult> {
  // Deduct spin cost
  await debitTokensForWheel(userId);

  // Determine reward: 70% credits only, 20% power-up, 10% cosmetic
  const roll = Math.random() * 100;

  if (roll < 70) {
    // Credits only (baseline 15, with small variance)
    const bonus = Math.floor(Math.random() * 11); // 0-10 bonus
    const totalCredits = BASELINE_CREDIT_REWARD + bonus;
    await creditTokens(userId, totalCredits, 'EARNED', 'Token wheel spin');

    await prisma.wheelSpin.create({
      data: {
        userId,
        cost: WHEEL_COST,
        rewardType: 'credits',
        rewardAmount: totalCredits,
      },
    });

    return { rewardType: 'credits', credits: totalCredits };
  }

  if (roll < 90) {
    // Power-up drop
    const powerUp = rollWeightedPowerUp();
    await prisma.powerUp.create({
      data: {
        userId,
        type: powerUp.type,
        quantity: 1,
      },
    });

    await prisma.wheelSpin.create({
      data: {
        userId,
        cost: WHEEL_COST,
        rewardType: 'power_up',
        rewardId: powerUp.type,
        rewardAmount: 0,
      },
    });

    return {
      rewardType: 'power_up',
      credits: 0,
      powerUp: {
        type: powerUp.type,
        description: getPowerUpDescription(powerUp.type),
      },
    };
  }

  // Cosmetic drop
  const cosmetic = COSMETIC_DROPS[Math.floor(Math.random() * COSMETIC_DROPS.length)];

  // Find or create the cosmetic item
  let cosmeticItem = await prisma.cosmeticItem.findUnique({
    where: { name: cosmetic.name },
  });
  if (!cosmeticItem) {
    cosmeticItem = await prisma.cosmeticItem.create({
      data: {
        name: cosmetic.name,
        type: cosmetic.type,
        rarity: cosmetic.rarity,
        price: 0, // wheel-exclusive
      },
    });
  }

  // Add to user's inventory (or duplicate = credits)
  const existing = await prisma.userCosmetic.findUnique({
    where: {
      userId_cosmeticId: {
        userId,
        cosmeticId: cosmeticItem.id,
      },
    },
  });

  if (existing) {
    // Duplicate cosmetic = 20 tokens compensation
    await creditTokens(userId, 20, 'EARNED', `Duplicate cosmetic: ${cosmetic.name}`);
    await prisma.wheelSpin.create({
      data: {
        userId,
        cost: WHEEL_COST,
        rewardType: 'cosmetic',
        rewardId: cosmeticItem.id,
        rewardAmount: 20,
      },
    });
    return { rewardType: 'cosmetic', credits: 20, cosmetic };
  }

  await prisma.userCosmetic.create({
    data: {
      userId,
      cosmeticId: cosmeticItem.id,
      equipped: false,
    },
  });

  await prisma.wheelSpin.create({
    data: {
      userId,
      cost: WHEEL_COST,
      rewardType: 'cosmetic',
      rewardId: cosmeticItem.id,
      rewardAmount: 0,
    },
  });

  return { rewardType: 'cosmetic', credits: 0, cosmetic };
}

async function debitTokensForWheel(userId: string): Promise<void> {
  const wallet = await prisma.tokenWallet.findFirst({ where: { userId } });
  if (!wallet || wallet.balance < WHEEL_COST) {
    throw new AppError('Not enough tokens to spin the wheel', 400);
  }
  // Inline debit to avoid circular dependency with tokens.service
  const newBalance = wallet.balance - WHEEL_COST;
  await prisma.tokenWallet.update({
    where: { id: wallet.id },
    data: { balance: newBalance },
  });
  await prisma.tokenTransaction.create({
    data: {
      walletId: wallet.id,
      amount: -WHEEL_COST,
      type: 'SPENT',
      description: 'Token wheel spin',
      balanceAfter: newBalance,
    },
  });
}

function rollWeightedPowerUp(): { type: PowerUpType; weight: number } {
  const totalWeight = POWER_UP_DROPS.reduce((sum, p) => sum + p.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const powerUp of POWER_UP_DROPS) {
    roll -= powerUp.weight;
    if (roll <= 0) return powerUp;
  }
  return POWER_UP_DROPS[POWER_UP_DROPS.length - 1];
}

function getPowerUpDescription(type: PowerUpType): string {
  switch (type) {
    case 'BOUNTY':
      return 'Assign a bounty to a random party member. If they fail their target, you steal their tokens.';
    case 'BS':
      return 'View your current bounty status — see if someone has a bounty on you.';
    case 'BS_PLUS':
      return 'Upgraded bounty radar — see your status AND the exact decrease needed to win.';
    case 'DOUBLE_DOWN':
      return '2x point multiplier on your next productive day, but 2x brain rot speed if you fail.';
    case 'SLIME_SHIELD':
      return '3-hour protection from slime damage — your brain stays clean no matter what.';
    case 'INHALE_ASSIST':
      return 'Shorten your next breathing gate by 5 seconds per phase.';
  }
}

// ─── Power-Up Management ─────────────────────────────────────────────────────

export async function getUserPowerUps(userId: string) {
  const powerUps = await prisma.powerUp.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const grouped = powerUps.reduce((acc, pu) => {
    const existing = acc.find((a) => a.type === pu.type);
    if (existing) {
      existing.quantity += pu.quantity;
    } else {
      acc.push({ type: pu.type, quantity: pu.quantity, description: getPowerUpDescription(pu.type) });
    }
    return acc;
  }, [] as { type: PowerUpType; quantity: number; description: string }[]);

  return grouped;
}

export async function activatePowerUp(userId: string, powerUpType: PowerUpType, targetPoolId?: string, targetUserId?: string) {
  const powerUp = await prisma.powerUp.findFirst({
    where: { userId, type: powerUpType, activatedAt: null },
  });

  if (!powerUp) {
    throw new AppError(`You don't have an unused ${powerUpType} power-up`, 404);
  }

  const now = new Date();
  let expiresAt: Date | null = null;

  switch (powerUpType) {
    case 'SLIME_SHIELD':
      expiresAt = new Date(now.getTime() + 3 * 60 * 60 * 1000); // 3 hours
      break;
    case 'DOUBLE_DOWN':
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
      break;
    case 'BOUNTY':
      if (!targetPoolId || !targetUserId) {
        throw new AppError('Bounty requires a target pool and user', 400);
      }
      break;
  }

  await prisma.powerUp.update({
    where: { id: powerUp.id },
    data: {
      activatedAt: now,
      expiresAt,
      targetPoolId: targetPoolId ?? null,
      targetUserId: targetUserId ?? null,
    },
  });

  return { message: `${powerUpType} activated successfully`, expiresAt };
}

// ─── Cosmetic Management ─────────────────────────────────────────────────────

export async function getUserCosmetics(userId: string) {
  return prisma.userCosmetic.findMany({
    where: { userId },
    include: { cosmetic: true },
    orderBy: { acquiredAt: 'desc' },
  });
}

export async function equipCosmetic(userId: string, userCosmeticId: string) {
  const item = await prisma.userCosmetic.findFirst({
    where: { id: userCosmeticId, userId },
  });
  if (!item) {
    throw new AppError('Cosmetic item not found in your inventory', 404);
  }

  // Unequip all items of the same type
  await prisma.userCosmetic.updateMany({
    where: {
      userId,
      cosmetic: { type: item.cosmeticId ? undefined : undefined }, // simplified
      equipped: true,
    },
    data: { equipped: false },
  });

  // Equip the selected item
  await prisma.userCosmetic.update({
    where: { id: userCosmeticId },
    data: { equipped: true },
  });

  return { message: 'Cosmetic equipped' };
}

// ─── Commitment Contracts ─────────────────────────────────────────────────────

export async function createContract(
  userId: string,
  data: {
    name: string;
    description?: string;
    pledgeAmountCents: number;
    targetScreenTime: number; // seconds per day
    startDate: Date;
    endDate: Date;
    charityName?: string;
  }
) {
  if (data.pledgeAmountCents < 100) {
    throw new AppError('Minimum pledge is $1.00', 400);
  }
  if (data.endDate <= data.startDate) {
    throw new AppError('End date must be after start date', 400);
  }

  return prisma.commitmentContract.create({
    data: {
      userId,
      name: data.name,
      description: data.description,
      pledgeAmount: data.pledgeAmountCents,
      targetScreenTime: data.targetScreenTime,
      startDate: data.startDate,
      endDate: data.endDate,
      charityName: data.charityName,
      status: 'ACTIVE',
    },
  });
}

export async function getUserContracts(userId: string) {
  return prisma.commitmentContract.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function cancelContract(userId: string, contractId: string) {
  const contract = await prisma.commitmentContract.findFirst({
    where: { id: contractId, userId },
  });
  if (!contract) {
    throw new AppError('Contract not found', 404);
  }
  if (contract.status !== 'ACTIVE') {
    throw new AppError(`Contract is already ${contract.status.toLowerCase()}`, 400);
  }

  return prisma.commitmentContract.update({
    where: { id: contractId },
    data: { status: 'CANCELLED' },
  });
}
