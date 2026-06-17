import { body, query } from 'express-validator';
import type { AppCategory } from '@prisma/client';

const VALID_CATEGORIES: AppCategory[] = [
  'SOCIAL',
  'GAMES',
  'ENTERTAINMENT',
  'PRODUCTIVITY',
  'UTILITIES',
  'PHOTO_VIDEO',
  'LIFESTYLE',
  'OTHER',
];

export const batchUpload = [
  body('entries')
    .isArray({ min: 1 })
    .withMessage('entries must be a non-empty array'),
  body('entries.*.appName')
    .notEmpty()
    .withMessage('appName is required'),
  body('entries.*.category')
    .isIn(VALID_CATEGORIES)
    .withMessage(`category must be one of: ${VALID_CATEGORIES.join(', ')}`),
  body('entries.*.duration')
    .isInt({ min: 1 })
    .withMessage('duration must be a positive integer'),
  body('entries.*.startedAt')
    .isISO8601()
    .withMessage('startedAt must be an ISO 8601 date'),
  body('entries.*.endedAt')
    .optional()
    .isISO8601()
    .withMessage('endedAt must be an ISO 8601 date'),
];

export const dateRange = [
  query('from')
    .isISO8601()
    .withMessage('from must be an ISO 8601 date'),
  query('to')
    .isISO8601()
    .withMessage('to must be an ISO 8601 date'),
];
