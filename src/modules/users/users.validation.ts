import { body, query } from 'express-validator';

/**
 * `PATCH /users/me` previously had no validation at all — no length caps on
 * `displayName`/`bio`, no format check on `avatarUrl`, no bounds on
 * `timezone`. See CODE_REVIEW.md #21.
 */
export const updateProfile = [
  body('displayName')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 50 })
    .withMessage('displayName must be at most 50 characters'),
  body('bio')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 500 })
    .withMessage('bio must be at most 500 characters'),
  body('avatarUrl')
    .optional({ nullable: true })
    .isURL({ protocols: ['https'], require_protocol: true })
    .withMessage('avatarUrl must be a valid https URL'),
  body('timezone')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 64 })
    .withMessage('timezone must be at most 64 characters'),
];

export const searchUsers = [
  query('q')
    .notEmpty()
    .withMessage('Query parameter "q" is required')
    .isLength({ max: 100 })
    .withMessage('Query parameter "q" must be at most 100 characters'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('limit must be between 1 and 50'),
];

export const stats = [
  query('from')
    .optional()
    .isISO8601()
    .withMessage('from must be an ISO 8601 date'),
  query('to')
    .optional()
    .isISO8601()
    .withMessage('to must be an ISO 8601 date'),
];
