import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { deposit, withdraw } from './payments.validation.js';
import {
  depositHandler,
  withdrawHandler,
  getCustomerHandler,
  connectOnboardingHandler,
  connectStatusHandler,
} from './payments.controller.js';

export const router = Router();

router.post('/deposit', authenticateToken, validate(deposit), depositHandler);
router.post('/withdraw', authenticateToken, validate(withdraw), withdrawHandler);
router.get('/customer', authenticateToken, getCustomerHandler);

// Stripe Connect onboarding — must be completed before /withdraw can succeed.
router.post('/connect/onboarding', authenticateToken, connectOnboardingHandler);
router.get('/connect/status', authenticateToken, connectStatusHandler);

// Webhook route is mounted separately in app.ts because it needs the raw body
// parser (express.raw) instead of express.json, and is authenticated via the
// Stripe signature header rather than a JWT.
export { webhookHandler } from './payments.controller.js';

export default router;
