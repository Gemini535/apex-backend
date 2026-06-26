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

export async function equipCosmetic(userId: string, userCosmeticId: string) {
  const item = await prisma.userCosmetic.findFirst({
    where: { id: userCosmeticId, userId },
  });
  if (!item) {
    throw new AppError('Cosmetic item not found in your inventory', 404);
  }

  // Unequip every other item first. (The original code tried to match on the
  // cosmetic.type via a sub-filter but the relation traversal was awkward and
  // didn't actually do per-type slotting — unconditionally unequipping all
  // keeps the semantics simple: one equipped cosmetic at a time.)
  await prisma.userCosmetic.updateMany({
    where: { userId, equipped: true },
    data: { equipped: false },
  });

  // Equip the selected item
  await prisma.userCosmetic.update({
    where: { id: userCosmeticId },
    data: { equipped: true },
  });

  return { message: 'Cosmetic equipped' };
}
