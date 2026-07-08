import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { createPool, joinPool, settlePool } from './pools.validation.js';
import {
  createPoolHandler,
  joinPoolHandler,
  leavePoolHandler,
  getPoolHandler,
  listPoolsHandler,
  settlePoolHandler,
  getPoolLedgerHandler,
} from './pools.controller.js';

export const router = Router();

router.post('/', authenticateToken, validate(createPool), createPoolHandler);
router.post('/:poolId/join', authenticateToken, validate(joinPool), joinPoolHandler);
router.post('/:poolId/leave', authenticateToken, leavePoolHandler);
router.get('/:poolId', authenticateToken, getPoolHandler);
router.get('/', authenticateToken, listPoolsHandler);
router.post('/:poolId/settle', authenticateToken, validate(settlePool), settlePoolHandler);
router.get('/:poolId/ledger', authenticateToken, getPoolLedgerHandler);

export default router;
