import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  register as registerValidation,
  login as loginValidation,
  oauth as oauthValidation,
  verify2FA as verify2FAValidation,
  setupSMS2FA as setupSMS2FAValidation,
  refreshToken as refreshTokenValidation,
  forgotPassword,
  resetPassword,
  verifyEmailBody,
} from './auth.validation.js';
import {
  register,
  login,
  verify2FALogin,
  appleAuth,
  googleAuth,
  refresh,
  logout,
  setup2FATotp,
  verifyAndEnable2FATotp,
  setup2FASMS,
  verifyAndEnable2FASMS,
  setup2FAEmail,
  verifyAndEnable2FAEmail,
  disable2FA,
} from './auth.controller.js';
import {
  listSessionsHandler,
  revokeSessionHandler,
  revokeAllSessionsHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  sendVerificationEmailHandler,
  verifyEmailHandler,
} from './auth-session.controller.js';

const router = Router();

// ─── Public routes ─────────────────────────────────────────────────────────

router.post('/register', validate(registerValidation), register);
router.post('/login', validate(loginValidation), login);
router.post('/login/2fa', validate(verify2FAValidation), verify2FALogin);
router.post('/apple', validate(oauthValidation), appleAuth);
router.post('/google', validate(oauthValidation), googleAuth);
router.post('/refresh', validate(refreshTokenValidation), refresh);
router.post('/logout', authenticateToken, logout);

// Password reset
router.post('/password/forgot', validate(forgotPassword), forgotPasswordHandler);
router.post('/password/reset', validate(resetPassword), resetPasswordHandler);

// Email verification (public — user clicks link in email)
router.post('/verify-email', validate(verifyEmailBody), verifyEmailHandler);

// ─── Authenticated 2FA routes ───────────────────────────────────────────────

router.post('/2fa/setup/totp', authenticateToken, setup2FATotp);
router.post('/2fa/verify/totp', authenticateToken, validate(verify2FAValidation), verifyAndEnable2FATotp);
router.post('/2fa/setup/sms', authenticateToken, validate(setupSMS2FAValidation), setup2FASMS);
router.post('/2fa/verify/sms', authenticateToken, validate(verify2FAValidation), verifyAndEnable2FASMS);
router.post('/2fa/setup/email', authenticateToken, setup2FAEmail);
router.post('/2fa/verify/email', authenticateToken, validate(verify2FAValidation), verifyAndEnable2FAEmail);
router.delete('/2fa', authenticateToken, validate(verify2FAValidation), disable2FA);

// ─── Session management ─────────────────────────────────────────────────────

router.get('/sessions', authenticateToken, listSessionsHandler);
router.post('/sessions/revoke', authenticateToken, revokeSessionHandler);
router.post('/sessions/revoke-all', authenticateToken, revokeAllSessionsHandler);

// ─── Email verification (authenticated — resend) ────────────────────────────

router.post('/verify-email/send', authenticateToken, sendVerificationEmailHandler);

export default router;
