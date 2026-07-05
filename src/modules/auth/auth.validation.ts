import { body } from 'express-validator';

export const register = [
  body('email')
    .isEmail()
    .withMessage('A valid email address is required')
    .normalizeEmail(),

  body('username')
    .isLength({ min: 3, max: 30 })
    .withMessage('Username must be between 3 and 30 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),

  body('password')
    // Upper bound prevents an attacker from submitting a multi-megabyte
    // string straight into bcrypt.hash — bcryptjs is a pure-JS
    // implementation with no built-in input-length cap, so an unbounded
    // password is a mild hashing-cost DoS vector (CODE_REVIEW.md #28).
    .isLength({ min: 8, max: 128 })
    .withMessage('Password must be between 8 and 128 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).+$/)
    .withMessage(
      'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character. Consider using a strong password like: ' +
        'MyStr0ng!Pass#2024'
    ),
];

export const login = [
  body('email')
    .isEmail()
    .withMessage('A valid email address is required')
    .normalizeEmail(),

  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ max: 128 })
    .withMessage('Password must be at most 128 characters long'),
];

export const oauth = [
  body('token')
    .notEmpty()
    .withMessage('OAuth token is required'),
];

export const verify2FA = [
  body('tempToken')
    .optional()
    .notEmpty()
    .withMessage('tempToken must not be empty when provided'),
  body('code')
    .isLength({ min: 6, max: 6 })
    .withMessage('2FA code must be exactly 6 digits')
    .isNumeric()
    .withMessage('2FA code must contain only numbers'),
];

export const send2FALoginCode = [
  body('tempToken')
    .notEmpty()
    .withMessage('tempToken is required'),
];

export const setupSMS2FA = [
  body('phoneNumber')
    .isMobilePhone('any')
    .withMessage('A valid phone number is required'),
];

export const refreshToken = [
  body('refreshToken')
    .notEmpty()
    .withMessage('Refresh token is required'),
];

// ─── Password Reset ──────────────────────────────────────────────────────────

export const forgotPassword = [
  body('email')
    .isEmail()
    .withMessage('A valid email address is required')
    .normalizeEmail(),
];

export const resetPassword = [
  body('token')
    .notEmpty()
    .withMessage('Reset token is required'),
  body('password')
    .isLength({ min: 8, max: 128 })
    .withMessage('Password must be between 8 and 128 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).+$/)
    .withMessage(
      'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character'
    ),
];

// ─── Email Verification ─────────────────────────────────────────────────────

export const verifyEmailBody = [
  body('token')
    .notEmpty()
    .withMessage('Verification token is required'),
];
