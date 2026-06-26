import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { getPowerUpsHandler, activatePowerUpHandler } from './powerups.controller.js';

export const router = Router();

router.get('/', authenticateToken, getPowerUpsHandler);
router.post('/activate', authenticateToken, activatePowerUpHandler);

export default router;
