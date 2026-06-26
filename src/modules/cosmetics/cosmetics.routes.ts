import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { getCosmeticsHandler, equipCosmeticHandler } from './cosmetics.controller.js';

export const router = Router();

router.get('/', authenticateToken, getCosmeticsHandler);
router.post('/equip', authenticateToken, equipCosmeticHandler);

export default router;
