import type { Request, Response, NextFunction } from 'express';
import { spinWheel } from './wheel.service.js';

export async function spinWheelHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await spinWheel(req.user!.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
