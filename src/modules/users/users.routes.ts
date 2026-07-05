import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { updateProfile, searchUsers, stats } from './users.validation.js';
import {
  getMe,
  updateMe,
  getUserByUsername,
  searchUsersHandler,
  getMyBrainState,
  getMyStats,
} from './users.controller.js';

const router = Router();

// Authenticated routes
router.get('/me', authenticateToken, getMe);
router.patch('/me', authenticateToken, validate(updateProfile), updateMe);
router.get('/search', authenticateToken, validate(searchUsers), searchUsersHandler);
router.get('/me/brain-state', authenticateToken, getMyBrainState);
router.get('/me/stats', authenticateToken, validate(stats), getMyStats);

// Parameterized route last to avoid collisions with /me/* paths
router.get('/:username', authenticateToken, getUserByUsername);

export default router;
