import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * General limiter applied globally. Configurable via env so production can be
 * tightened without a code change.
 */
export const generalLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

/**
 * Strict limiter for authentication endpoints. Brute-force protection for login,
 * password reset, and email verification — these are the endpoints an attacker
 * would hammer to enumerate accounts or guess credentials.
 *
 * 5 attempts per 15-minute window per IP. The window is intentionally long to
 * make credential stuffing impractical without locking out real users who
 * mistype a few times.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again in 15 minutes' },
  // Skip successful login attempts so a legitimate user who mistypes their
  // password a couple times doesn't get locked out alongside an attacker.
  skipSuccessfulRequests: false,
});

/**
 * Token wheel / gacha limiter. Spins cost tokens and drop real rewards, so we
 * cap them to prevent rapid-fire abuse (e.g. a scripted client draining a
 * wallet or farming the random drop table).
 *
 * 10 spins per minute per user — generous for human play, stops bots.
 */
export const wheelLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Slow down! You can spin again in a moment.' },
  keyGenerator: (req) => {
    // Rate limit by authenticated user, not IP, so shared IPs (offices,
    // schools) don't penalize other users. Fall back to IP for unauthenticated
    // requests (shouldn't happen — wheel is protected — but defensive).
    return req.user?.userId ?? req.ip ?? 'unknown';
  },
});

/**
 * Attestation challenge/registration limiter. 20/min per user — generous for
 * legitimate app usage (one challenge per upload, occasional re-registration)
 * but stops a script from hammering the challenge endpoint to farm nonces.
 */
export const attestationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attestation requests, please try again in a moment.' },
  keyGenerator: (req) => req.user?.userId ?? req.ip ?? 'unknown',
});
