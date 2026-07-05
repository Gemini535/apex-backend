import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { authLimiter } from '../../middleware/rateLimiter.js';
import {
  register as registerValidation,
  login as loginValidation,
  oauth as oauthValidation,
  verify2FA as verify2FAValidation,
  send2FALoginCode as send2FALoginCodeValidation,
  setupSMS2FA as setupSMS2FAValidation,
  refreshToken as refreshTokenValidation,
  forgotPassword,
  resetPassword,
  verifyEmailBody,
} from './auth.validation.js';
import {
  register,
  login,
  send2FALoginCode,
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
router.post('/login', authLimiter, validate(loginValidation), login);
// Rate-limited: sends a real SMS/email, so it must be protected from spam
// exactly like login/password-reset (see rateLimiter.ts's authLimiter).
router.post('/login/2fa/send', authLimiter, validate(send2FALoginCodeValidation), send2FALoginCode);
router.post('/login/2fa', authLimiter, validate(verify2FAValidation), verify2FALogin);
router.post('/apple', validate(oauthValidation), appleAuth);
router.post('/google', validate(oauthValidation), googleAuth);
router.post('/refresh', validate(refreshTokenValidation), refresh);
router.post('/logout', authenticateToken, logout);

// Password reset — strict limiter prevents email enumeration & SMS pumping
router.post('/password/forgot', authLimiter, validate(forgotPassword), forgotPasswordHandler);
router.post('/password/reset', authLimiter, validate(resetPassword), resetPasswordHandler);

// Email verification (public — user clicks link in email)
router.post('/verify-email', authLimiter, validate(verifyEmailBody), verifyEmailHandler);

// ─── Authenticated 2FA routes ───────────────────────────────────────────────

// authLimiter added to every code-verifying/code-sending route here, not
// just login — these all either brute-forceable a 6-digit code or trigger a
// real SMS/email send, so they need the same defense-in-depth as
// login/password-reset (previously none of them were rate-limited at all).
router.post('/2fa/setup/totp', authenticateToken, setup2FATotp);
router.post('/2fa/verify/totp', authLimiter, authenticateToken, validate(verify2FAValidation), verifyAndEnable2FATotp);
router.post('/2fa/setup/sms', authLimiter, authenticateToken, validate(setupSMS2FAValidation), setup2FASMS);
router.post('/2fa/verify/sms', authLimiter, authenticateToken, validate(verify2FAValidation), verifyAndEnable2FASMS);
router.post('/2fa/setup/email', authLimiter, authenticateToken, setup2FAEmail);
router.post('/2fa/verify/email', authLimiter, authenticateToken, validate(verify2FAValidation), verifyAndEnable2FAEmail);
router.delete('/2fa', authLimiter, authenticateToken, validate(verify2FAValidation), disable2FA);

// ─── Session management ─────────────────────────────────────────────────────

router.get('/sessions', authenticateToken, listSessionsHandler);
router.post('/sessions/revoke', authenticateToken, revokeSessionHandler);
router.post('/sessions/revoke-all', authenticateToken, revokeAllSessionsHandler);

// ─── Email verification (authenticated — resend) ────────────────────────────

router.post('/verify-email/send', authenticateToken, sendVerificationEmailHandler);

export default router;
