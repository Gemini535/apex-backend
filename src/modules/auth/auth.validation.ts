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
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
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
    .withMessage('Password is required'),
];

export const oauth = [
  body('token')
    .notEmpty()
    .withMessage('OAuth token is required'),
];

export const verify2FA = [
  body('code')
    .isLength({ min: 6, max: 6 })
    .withMessage('2FA code must be exactly 6 digits')
    .isNumeric()
    .withMessage('2FA code must contain only numbers'),
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
