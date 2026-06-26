import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { pagination } from './tokens.validation.js';
import { getBalanceHandler, getTransactionsHandler } from './tokens.controller.js';

export const router = Router();

router.get('/balance', authenticateToken, getBalanceHandler);
router.get('/transactions', authenticateToken, validate(pagination), getTransactionsHandler);

export default router;
