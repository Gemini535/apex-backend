import type { Request, Response, NextFunction } from 'express';
import {
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  blockUser,
  unblockUser,
  getFriendsList,
  getPendingRequests,
  getSentRequests,
} from './friends.service.js';

export async function sendRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username } = req.body as { username: string };
    const request = await sendFriendRequest(req.user!.userId, username);
    res.status(201).json({ message: 'Friend request sent', request });
  } catch (error) {
    next(error);
  }
}

export async function acceptRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { requestId } = req.body as { requestId: string };
    const friendship = await acceptFriendRequest(req.user!.userId, requestId);
    res.json({ message: 'Friend request accepted', friendship });
  } catch (error) {
    next(error);
  }
}

export async function declineRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { requestId } = req.body as { requestId: string };
    await declineFriendRequest(req.user!.userId, requestId);
    res.json({ message: 'Friend request declined' });
  } catch (error) {
    next(error);
  }
}

export async function unfriend(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await removeFriend(req.user!.userId, req.params.userId);
    res.json({ message: 'Friend removed' });
  } catch (error) {
    next(error);
  }
}

export async function block(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId: blockedId } = req.body as { userId: string };
    await blockUser(req.user!.userId, blockedId);
    res.json({ message: 'User blocked' });
  } catch (error) {
    next(error);
  }
}

export async function unblock(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await unblockUser(req.user!.userId, req.params.userId);
    res.json({ message: 'User unblocked' });
  } catch (error) {
    next(error);
  }
}

export async function listFriends(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const friends = await getFriendsList(req.user!.userId);
    res.json({ friends });
  } catch (error) {
    next(error);
  }
}

export async function pendingRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requests = await getPendingRequests(req.user!.userId);
    res.json({ requests });
  } catch (error) {
    next(error);
  }
}

export async function sentRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requests = await getSentRequests(req.user!.userId);
    res.json({ requests });
  } catch (error) {
    next(error);
  }
}
