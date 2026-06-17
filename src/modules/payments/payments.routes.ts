import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { createPool, joinPool } from './payments.validation.js';
import {
  getBalanceHandler,
  getTransactionsHandler,
  depositHandler,
  withdrawHandler,
  webhookHandler,
  getCustomerHandler,
  createPoolHandler,
  joinPoolHandler,
  leavePoolHandler,
  getPoolHandler,
  listPoolsHandler,
  settlePoolHandler,
  getPoolLedgerHandler,
} from './payments.controller.js';

const router = Router();

// ─── Token endpoints ────────────────────────────────────────────────────────

router.get('/tokens/balance', authenticateToken, getBalanceHandler);
router.get('/tokens/transactions', authenticateToken, getTransactionsHandler);

// ─── Stripe payment endpoints ───────────────────────────────────────────────

router.post('/payments/deposit', authenticateToken, depositHandler);
router.post('/payments/withdraw', authenticateToken, withdrawHandler);
router.get('/payments/customer', authenticateToken, getCustomerHandler);

// Stripe webhook — must be raw body, no auth (Stripe signs the payload)
// This route is mounted separately in app.ts with raw body parser

// ─── Pool endpoints ──────────────────────────────────────────────────────────

router.post('/pools', authenticateToken, validate(createPool), createPoolHandler);
router.post('/pools/:poolId/join', authenticateToken, validate(joinPool), joinPoolHandler);
router.post('/pools/:poolId/leave', authenticateToken, leavePoolHandler);
router.get('/pools/:poolId', authenticateToken, getPoolHandler);
router.get('/pools', authenticateToken, listPoolsHandler);
router.post('/pools/:poolId/settle', authenticateToken, settlePoolHandler);
router.get('/pools/:poolId/ledger', authenticateToken, getPoolLedgerHandler);

export { webhookHandler };
export default router;
