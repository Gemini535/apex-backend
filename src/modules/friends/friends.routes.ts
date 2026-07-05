import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  sendRequest,
  acceptRequest,
  declineRequest,
  unfriend,
  block,
  unblock,
  listFriends,
  pendingRequests,
  sentRequests,
} from './friends.controller.js';
import {
  sendRequest as sendRequestValidation,
  handleRequest,
  blockUser,
  unfriendUser,
  unblockUser,
} from './friends.validation.js';

const router = Router();

// Send friend request
router.post('/request', authenticateToken, validate(sendRequestValidation), sendRequest);

// Accept friend request
router.post('/accept', authenticateToken, validate(handleRequest), acceptRequest);

// Decline friend request
router.post('/decline', authenticateToken, validate(handleRequest), declineRequest);

// Remove friend — `unfriendUser` existed but was never wired in, so a
// malformed :userId went straight to Prisma and surfaced as a raw DB error
// instead of a clean 400 (CODE_REVIEW.md #21).
router.delete('/:userId', authenticateToken, validate(unfriendUser), unfriend);

// Block user
router.post('/block', authenticateToken, validate(blockUser), block);

// Unblock user
router.delete('/block/:userId', authenticateToken, validate(unblockUser), unblock);

// Get friends list
router.get('/', authenticateToken, listFriends);

// Get pending incoming requests
router.get('/requests/pending', authenticateToken, pendingRequests);

// Get sent pending requests
router.get('/requests/sent', authenticateToken, sentRequests);

export default router;
