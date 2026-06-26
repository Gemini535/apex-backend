import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { createContractHandler, getContractsHandler, cancelContractHandler } from './commitments.controller.js';

export const router = Router();

router.post('/', authenticateToken, createContractHandler);
router.get('/', authenticateToken, getContractsHandler);
router.post('/:contractId/cancel', authenticateToken, cancelContractHandler);

export default router;
