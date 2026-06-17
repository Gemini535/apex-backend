import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
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
router.patch('/me', authenticateToken, updateMe);
router.get('/search', authenticateToken, searchUsersHandler);
router.get('/me/brain-state', authenticateToken, getMyBrainState);
router.get('/me/stats', authenticateToken, getMyStats);

// Parameterized route last to avoid collisions with /me/* paths
router.get('/:username', authenticateToken, getUserByUsername);

export default router;
