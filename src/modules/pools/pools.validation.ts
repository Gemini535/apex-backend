import { body, param } from 'express-validator';

export const createPool = [
  body('name')
    .notEmpty()
    .withMessage('Pool name is required')
    .isLength({ min: 1, max: 100 })
    .withMessage('Pool name must be between 1 and 100 characters'),

  body('entryFee')
    .isInt({ min: 1, max: 10000 })
    .withMessage('Entry fee must be between 1 and 10,000 tokens'),

  body('maxParticipants')
    .optional()
    .isInt({ min: 2 })
    .withMessage('Max participants must be at least 2'),

  body('endsAt')
    .isISO8601()
    .withMessage('endsAt must be a valid ISO 8601 date')
    .custom((value: string) => {
      const endDate = new Date(value);
      if (endDate <= new Date()) {
        throw new Error('endsAt must be in the future');
      }
      return true;
    }),
];

export const joinPool = [
  param('poolId')
    .isUUID()
    .withMessage('poolId must be a valid UUID'),
];

export const settlePool = [
  param('poolId')
    .isUUID()
    .withMessage('poolId must be a valid UUID'),
];
