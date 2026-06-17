import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { batchUpload, dateRange } from './screentime.validation.js';
import {
  uploadBatch,
  getToday,
  getRange,
  getApps,
  getCategories,
  getActive,
} from './screentime.controller.js';

const router = Router();

router.post('/batch', authenticateToken, validate(batchUpload), uploadBatch);
router.get('/today', authenticateToken, getToday);
router.get('/range', authenticateToken, validate(dateRange), getRange);
router.get('/apps', authenticateToken, getApps);
router.get('/categories', authenticateToken, getCategories);
router.get('/active', authenticateToken, getActive);

export default router;
