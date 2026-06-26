import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import { getUserCosmetics, equipCosmetic } from './cosmetics.service.js';

export async function getCosmeticsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cosmetics = await getUserCosmetics(req.user!.userId);
    res.json({ cosmetics });
  } catch (err) {
    next(err);
  }
}

export async function equipCosmeticHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userCosmeticId } = req.body;
    if (!userCosmeticId) throw new AppError('userCosmeticId is required', 400);

    const result = await equipCosmetic(req.user!.userId, userCosmeticId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
