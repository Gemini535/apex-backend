import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';

// ─── Cosmetic Management ─────────────────────────────────────────────────────

export async function getUserCosmetics(userId: string) {
  return prisma.userCosmetic.findMany({
    where: { userId },
    include: { cosmetic: true },
    orderBy: { acquiredAt: 'desc' },
  });
}

/**
 * Equips a cosmetic into its own slot (HAT, GLASSES, HEADPHONES, etc.) —
 * equipping one no longer unequips items of a *different* type. The schema
 * (`CosmeticType`) clearly models independent slots, but the previous
 * implementation unconditionally unequipped every other item regardless of
 * type, so equipping a hat would silently unequip a previously-equipped
 * pair of glasses (CODE_REVIEW.md #22).
 */
export async function equipCosmetic(userId: string, userCosmeticId: string) {
  const item = await prisma.userCosmetic.findFirst({
    where: { id: userCosmeticId, userId },
    include: { cosmetic: true },
  });
  if (!item) {
    throw new AppError('Cosmetic item not found in your inventory', 404);
  }

  await prisma.$transaction([
    // Unequip only other items of the SAME slot/type.
    prisma.userCosmetic.updateMany({
      where: {
        userId,
        equipped: true,
        id: { not: userCosmeticId },
        cosmetic: { type: item.cosmetic.type },
      },
      data: { equipped: false },
    }),
    // Equip the selected item.
    prisma.userCosmetic.update({
      where: { id: userCosmeticId },
      data: { equipped: true },
    }),
  ]);

  return { message: 'Cosmetic equipped' };
}
