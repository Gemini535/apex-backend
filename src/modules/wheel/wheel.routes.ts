import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { wheelLimiter } from '../../middleware/rateLimiter.js';
import { spinWheelHandler } from './wheel.controller.js';

export const router = Router();

// authenticateToken runs first so wheelLimiter can key off req.user.userId
router.post('/spin', authenticateToken, wheelLimiter, spinWheelHandler);

export default router;
