import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { body, param } from 'express-validator';
import {
  registerDeviceHandler,
  listDevicesHandler,
  unregisterDeviceHandler,
  updateDeviceHandler,
} from './devices.controller.js';

export const router = Router();

const registerValidation = [
  body('token')
    .isString()
    .withMessage('token must be a string')
    .isLength({ min: 10, max: 200 })
    .withMessage('token must be between 10 and 200 characters'),
  body('platform')
    .optional()
    .isIn(['ios', 'android'])
    .withMessage('platform must be ios or android'),
];

const unregisterValidation = [
  param('token')
    .isString()
    .withMessage('token must be a string'),
];

router.post('/register', authenticateToken, validate(registerValidation), registerDeviceHandler);
router.get('/', authenticateToken, listDevicesHandler);
router.put('/', authenticateToken, validate(registerValidation), updateDeviceHandler);
router.delete('/:token', authenticateToken, validate(unregisterValidation), unregisterDeviceHandler);

export default router;
