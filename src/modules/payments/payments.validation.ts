import { body } from 'express-validator';

export const deposit = [
  body('amount')
    .isInt({ min: 100, max: 50000 })
    .withMessage('amount must be between 100 ($1.00) and 50,000 ($500.00) cents'),
  body('idempotencyKey')
    .notEmpty()
    .withMessage('idempotencyKey is required to prevent duplicate charges'),
];

export const withdraw = [
  body('amount')
    .isInt({ min: 100 })
    .withMessage('amount must be at least 100 tokens ($1.00)'),
  body('idempotencyKey')
    .notEmpty()
    .withMessage('idempotencyKey is required to prevent duplicate withdrawals'),
];
