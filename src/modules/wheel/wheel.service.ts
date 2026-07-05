import { prisma } from '../../config/database.js';
import { creditTokens, debitTokens } from '../tokens/tokens.service.js';
import type { PowerUpType } from '@prisma/client';

// ─── Constants ────────────────────────────────────────────────────────────────

const WHEEL_COST = 10; // tokens per spin
const BASELINE_CREDIT_REWARD = 15; // minimum tokens earned per spin

/** The 6 power-ups that can drop from the wheel, with their rarity weights. */
const POWER_UP_DROPS: { type: PowerUpType; weight: number }[] = [
  { type: 'INHALE_ASSIST', weight: 30 }, // most common — small convenience
  { type: 'BS', weight: 25 }, // common — informational
  { type: 'SLIME_SHIELD', weight: 20 }, // uncommon — defensive
  { type: 'DOUBLE_DOWN', weight: 10 }, // rare — high risk/reward
  { type: 'BS_PLUS', weight: 8 }, // rare — upgraded informational
  { type: 'BOUNTY', weight: 7 }, // rarest — offensive PvP
];

/** Cosmetic drops (simplified — in production, these come from the DB). */
const COSMETIC_DROPS = [
  { name: 'Retro Headphones', type: 'HEADPHONES' as const, rarity: 'COMMON' as const },
  { name: 'Tiny Coffee Cup', type: 'COFFEE_CUP' as const, rarity: 'COMMON' as const },
  { name: 'Cyber Shades', type: 'GLASSES' as const, rarity: 'RARE' as const },
  { name: 'Neon Beanie', type: 'HAT' as const, rarity: 'RARE' as const },
  { name: 'Golden Crown', type: 'HAT' as const, rarity: 'LEGENDARY' as const },
];

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * Spin the token wheel. Costs 10 tokens and guarantees at least 15 tokens back.
 * May also drop a power-up or cosmetic item.
 *
 * The whole spin — cost debit, reward roll, and reward grant — runs inside a
 * single transaction so a crash mid-spin can never charge the cost without
 * granting a reward (or vice versa). The debit itself goes through
 * `tokens.service`'s atomic, race-safe helper (guarded raw UPDATE) rather
 * than a hand-rolled read-then-write, which was a lost-update/double-spend
 * race under concurrent spins (CODE_REVIEW.md #1).
 */
export async function spinWheel(userId: string): Promise<WheelSpinResult> {
  return prisma.$transaction(async (tx) => {
    await debitTokens(userId, WHEEL_COST, 'SPENT', 'Token wheel spin', undefined, tx);

    // Determine reward: 70% credits only, 20% power-up, 10% cosmetic
    const roll = Math.random() * 100;

    if (roll < 70) {
      const bonus = Math.floor(Math.random() * 11); // 0-10 bonus
      const totalCredits = BASELINE_CREDIT_REWARD + bonus;
      await creditTokens(userId, totalCredits, 'EARNED', 'Token wheel spin', undefined, tx);

      await tx.wheelSpin.create({
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
      await tx.powerUp.create({
        data: {
          userId,
          type: powerUp.type,
          quantity: 1,
        },
      });

      await tx.wheelSpin.create({
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

    let cosmeticItem = await tx.cosmeticItem.findUnique({
      where: { name: cosmetic.name },
    });
    if (!cosmeticItem) {
      cosmeticItem = await tx.cosmeticItem.create({
        data: {
          name: cosmetic.name,
          type: cosmetic.type,
          rarity: cosmetic.rarity,
          price: 0, // wheel-exclusive
        },
      });
    }

    const existing = await tx.userCosmetic.findUnique({
      where: {
        userId_cosmeticId: {
          userId,
          cosmeticId: cosmeticItem.id,
        },
      },
    });

    if (existing) {
      // Duplicate cosmetic = 20 tokens compensation
      await creditTokens(userId, 20, 'EARNED', `Duplicate cosmetic: ${cosmetic.name}`, undefined, tx);
      await tx.wheelSpin.create({
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

    await tx.userCosmetic.create({
      data: {
        userId,
        cosmeticId: cosmeticItem.id,
        equipped: false,
      },
    });

    await tx.wheelSpin.create({
      data: {
        userId,
        cost: WHEEL_COST,
        rewardType: 'cosmetic',
        rewardId: cosmeticItem.id,
        rewardAmount: 0,
      },
    });

    return { rewardType: 'cosmetic', credits: 0, cosmetic };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
