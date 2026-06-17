import dotenv from 'dotenv';
import { logger } from './logger.js';

dotenv.config();

function getEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// ─── Secret validation ───────────────────────────────────────────────────────

/** Secrets that must not be used in production (placeholders / defaults). */
const BLOCKED_SECRETS = [
  'change-this-to-a-random-256-bit-secret-in-production',
  'change-this-to-another-random-256-bit-secret',
  'placeholder',
  'secret',
  'password',
  'admin',
  'default',
];

/** Minimum length for a JWT secret (128 bits = 16 bytes, expressed as 24+ base64 chars). */
const MIN_JWT_SECRET_LENGTH = 24;

function validateJwtSecret(secret: string, name: string): void {
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `${name} must be at least ${MIN_JWT_SECRET_LENGTH} characters. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  for (const blocked of BLOCKED_SECRETS) {
    if (secret.toLowerCase() === blocked.toLowerCase()) {
      throw new Error(
        `${name} is using a blocked placeholder value. ` +
        `Set a real secret in your .env file. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      );
    }
  }
}

function validateSecrets(): void {
  validateJwtSecret(env.jwt.secret, 'JWT_SECRET');
  validateJwtSecret(env.jwt.refreshSecret, 'JWT_REFRESH_SECRET');

  if (env.jwt.secret === env.jwt.refreshSecret) {
    throw new Error(
      'JWT_SECRET and JWT_REFRESH_SECRET must be different values. ' +
      'Generate two separate secrets with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  // Warn (don't throw) if Stripe keys are still placeholders in production
  if (env.nodeEnv === 'production') {
    if (env.stripe.secretKey.startsWith('sk_test_') || env.stripe.secretKey === 'sk_test_placeholder') {
      logger.warn('Running in production with a test-mode Stripe secret key');
    }
  }
}

export const env = {
  port: parseInt(getEnv('PORT', '3000'), 10),
  nodeEnv: getEnv('NODE_ENV', 'development'),

  database: {
    url: getEnv('DATABASE_URL'),
  },

  jwt: {
    secret: getEnv('JWT_SECRET'),
    refreshSecret: getEnv('JWT_REFRESH_SECRET'),
    accessExpiry: getEnv('JWT_ACCESS_EXPIRY', '15m'),
    refreshExpiry: getEnv('JWT_REFRESH_EXPIRY', '7d'),
  },

  apple: {
    clientId: getEnv('APPLE_CLIENT_ID', ''),
    teamId: getEnv('APPLE_TEAM_ID', ''),
    keyId: getEnv('APPLE_KEY_ID', ''),
    privateKeyPath: getEnv('APPLE_PRIVATE_KEY_PATH', ''),
  },

  google: {
    clientId: getEnv('GOOGLE_CLIENT_ID', ''),
    clientSecret: getEnv('GOOGLE_CLIENT_SECRET', ''),
  },

  totp: {
    issuer: getEnv('TOTP_ISSUER', 'Apex'),
  },

  twilio: {
    accountSid: getEnv('TWILIO_ACCOUNT_SID', ''),
    authToken: getEnv('TWILIO_AUTH_TOKEN', ''),
    phoneNumber: getEnv('TWILIO_PHONE_NUMBER', ''),
  },

  smtp: {
    host: getEnv('SMTP_HOST', ''),
    port: parseInt(getEnv('SMTP_PORT', '587'), 10),
    user: getEnv('SMTP_USER', ''),
    pass: getEnv('SMTP_PASS', ''),
    from: getEnv('SMTP_FROM', 'noreply@apex-app.com'),
  },

  stripe: {
    secretKey: getEnv('STRIPE_SECRET_KEY', 'sk_test_placeholder'),
    webhookSecret: getEnv('STRIPE_WEBHOOK_SECRET', 'whsec_placeholder'),
  },

  rateLimit: {
    windowMs: parseInt(getEnv('RATE_LIMIT_WINDOW_MS', '900000'), 10),
    max: parseInt(getEnv('RATE_LIMIT_MAX', '100'), 10),
  },
} as const;

// Validate secrets at module load time (fails fast on startup)
validateSecrets();
