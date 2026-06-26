import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { PowerUpType } from '@prisma/client';

// ─── Constants ────────────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const SLIME_SHIELD_DURATION_MS =
  3 * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const DOUBLE_DOWN_DURATION_MS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

const POWER_UP_DESCRIPTIONS: Record<PowerUpType, string> = {
  BOUNTY:
    'Assign a bounty to a random party member. If they fail their target, you steal their tokens.',
  BS: 'View your current bounty status — see if someone has a bounty on you.',
  BS_PLUS:
    'Upgraded bounty radar — see your status AND the exact decrease needed to win.',
  DOUBLE_DOWN:
    '2x point multiplier on your next productive day, but 2x brain rot speed if you fail.',
  SLIME_SHIELD:
    '3-hour protection from slime damage — your brain stays clean no matter what.',
  INHALE_ASSIST: 'Shorten your next breathing gate by 5 seconds per phase.',
};

export function getPowerUpDescription(type: PowerUpType): string {
  return POWER_UP_DESCRIPTIONS[type];
}

// ─── Query ────────────────────────────────────────────────────────────────────

export async function getUserPowerUps(userId: string) {
  const powerUps = await prisma.powerUp.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const grouped = powerUps.reduce(
    (acc, pu) => {
      const existing = acc.find((a) => a.type === pu.type);
      if (existing) {
        existing.quantity += pu.quantity;
      } else {
        acc.push({
          type: pu.type,
          quantity: pu.quantity,
          description: POWER_UP_DESCRIPTIONS[pu.type],
        });
      }
      return acc;
    },
    [] as { type: PowerUpType; quantity: number; description: string }[],
  );

  return grouped;
}

// ─── Activate ───────────────────────────────────────────────────────────────

export async function activatePowerUp(
  userId: string,
  powerUpType: PowerUpType,
  targetPoolId?: string,
  targetUserId?: string,
) {
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
      expiresAt = new Date(now.getTime() + SLIME_SHIELD_DURATION_MS);
      break;
    case 'DOUBLE_DOWN':
      expiresAt = new Date(now.getTime() + DOUBLE_DOWN_DURATION_MS);
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
