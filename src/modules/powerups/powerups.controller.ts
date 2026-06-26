import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import { getUserPowerUps, activatePowerUp } from './powerups.service.js';

export async function getPowerUpsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const powerUps = await getUserPowerUps(req.user!.userId);
    res.json({ powerUps });
  } catch (err) {
    next(err);
  }
}

export async function activatePowerUpHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { powerUpType, targetPoolId, targetUserId } = req.body;
    if (!powerUpType) throw new AppError('powerUpType is required', 400);

    const result = await activatePowerUp(req.user!.userId, powerUpType, targetPoolId, targetUserId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
