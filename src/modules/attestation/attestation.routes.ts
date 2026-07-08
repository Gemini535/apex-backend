import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { attestationLimiter } from '../../middleware/rateLimiter.js';
import { issueChallenge, registerKey } from './attestation.validation.js';
import { issueChallengeHandler, registerKeyHandler } from './attestation.controller.js';

const router = Router();

router.post('/challenge', authenticateToken, attestationLimiter, validate(issueChallenge), issueChallengeHandler);
router.post('/register-key', authenticateToken, attestationLimiter, validate(registerKey), registerKeyHandler);

export default router;
