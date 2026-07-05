import { body, param } from 'express-validator';

export const sendRequest = [
  body('username')
    .notEmpty()
    .withMessage('Username is required')
    .isLength({ min: 3, max: 30 })
    .withMessage('Username must be between 3 and 30 characters'),
];

export const handleRequest = [
  body('requestId')
    .isUUID()
    .withMessage('Request ID must be a valid UUID'),
];

export const unfriendUser = [
  param('userId')
    .isUUID()
    .withMessage('User ID must be a valid UUID'),
];

export const blockUser = [
  body('userId')
    .isUUID()
    .withMessage('User ID must be a valid UUID'),
];

export const unblockUser = [
  param('userId')
    .isUUID()
    .withMessage('User ID must be a valid UUID'),
];
