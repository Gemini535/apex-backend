import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { isUserOnline } from '../../shared/websocket/socket.js';
import type { FriendRequest, Friendship, User } from '@prisma/client';

// ─── Send Friend Request ─────────────────────────────────────────────────────

export async function sendFriendRequest(
  senderId: string,
  targetUsername: string
): Promise<FriendRequest & { sender: User; receiver: User }> {
  const targetUser = await prisma.user.findUnique({
    where: { username: targetUsername },
  });

  if (!targetUser) {
    throw new AppError('User not found', 404);
  }

  if (targetUser.id === senderId) {
    throw new AppError('Cannot send a friend request to yourself', 400);
  }

  const blocked = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        { blockerId: senderId, blockedId: targetUser.id },
        { blockerId: targetUser.id, blockedId: senderId },
      ],
    },
  });

  if (blocked) {
    throw new AppError('Cannot send friend request to this user', 403);
  }

  const existingFriendship = await prisma.friendship.findFirst({
    where: {
      OR: [
        { userId: senderId, friendId: targetUser.id },
        { userId: targetUser.id, friendId: senderId },
      ],
    },
  });

  if (existingFriendship) {
    throw new AppError('Users are already friends', 409);
  }

  const existingRequest = await prisma.friendRequest.findFirst({
    where: {
      OR: [
        { senderId: senderId, receiverId: targetUser.id },
        { senderId: targetUser.id, receiverId: senderId },
      ],
      status: 'PENDING',
    },
  });

  if (existingRequest) {
    throw new AppError('A pending friend request already exists', 409);
  }

  const request = await prisma.friendRequest.create({
    data: {
      senderId: senderId,
      receiverId: targetUser.id,
    },
    include: {
      sender: true,
      receiver: true,
    },
  });

  return request;
}

// ─── Accept Friend Request ───────────────────────────────────────────────────

export async function acceptFriendRequest(
  userId: string,
  requestId: string
): Promise<Friendship> {
  const request = await prisma.friendRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new AppError('Friend request not found', 404);
  }

  if (request.receiverId !== userId) {
    throw new AppError('You are not the receiver of this request', 403);
  }

  if (request.status !== 'PENDING') {
    throw new AppError(`Friend request is already ${request.status.toLowerCase()}`, 400);
  }

  await prisma.friendRequest.update({
    where: { id: requestId },
    data: { status: 'ACCEPTED' },
  });

  const friendship = await prisma.friendship.create({
    data: {
      userId: request.senderId,
      friendId: request.receiverId,
    },
  });

  await prisma.friendRequest.delete({
    where: { id: requestId },
  });

  return friendship;
}

// ─── Decline Friend Request ──────────────────────────────────────────────────

export async function declineFriendRequest(
  userId: string,
  requestId: string
): Promise<{ success: boolean }> {
  const request = await prisma.friendRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new AppError('Friend request not found', 404);
  }

  if (request.receiverId !== userId) {
    throw new AppError('You are not the receiver of this request', 403);
  }

  if (request.status !== 'PENDING') {
    throw new AppError(`Friend request is already ${request.status.toLowerCase()}`, 400);
  }

  await prisma.friendRequest.update({
    where: { id: requestId },
    data: { status: 'DECLINED' },
  });

  return { success: true };
}

// ─── Remove Friend ───────────────────────────────────────────────────────────

export async function removeFriend(
  userId: string,
  friendId: string
): Promise<{ success: boolean }> {
  const friendship = await prisma.friendship.findFirst({
    where: {
      OR: [
        { userId: userId, friendId: friendId },
        { userId: friendId, friendId: userId },
      ],
    },
  });

  if (!friendship) {
    throw new AppError('Friendship not found', 404);
  }

  await prisma.friendship.delete({
    where: { id: friendship.id },
  });

  return { success: true };
}

// ─── Block User ──────────────────────────────────────────────────────────────

export async function blockUser(
  blockerId: string,
  blockedId: string
): Promise<{ success: boolean }> {
  if (blockerId === blockedId) {
    throw new AppError('Cannot block yourself', 400);
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: blockedId },
  });

  if (!targetUser) {
    throw new AppError('User not found', 404);
  }

  // Remove any existing friendships
  await prisma.friendship.deleteMany({
    where: {
      OR: [
        { userId: blockerId, friendId: blockedId },
        { userId: blockedId, friendId: blockerId },
      ],
    },
  });

  // Remove any pending friend requests between them
  await prisma.friendRequest.deleteMany({
    where: {
      OR: [
        { senderId: blockerId, receiverId: blockedId },
        { senderId: blockedId, receiverId: blockerId },
      ],
      status: 'PENDING',
    },
  });

  // Create blocked user record
  await prisma.blockedUser.upsert({
    where: {
      blockerId_blockedId: {
        blockerId: blockerId,
        blockedId: blockedId,
      },
    },
    update: {},
    create: {
      blockerId: blockerId,
      blockedId: blockedId,
    },
  });

  return { success: true };
}

// ─── Unblock User ────────────────────────────────────────────────────────────

export async function unblockUser(
  blockerId: string,
  blockedId: string
): Promise<{ success: boolean }> {
  const blocked = await prisma.blockedUser.findUnique({
    where: {
      blockerId_blockedId: {
        blockerId: blockerId,
        blockedId: blockedId,
      },
    },
  });

  if (!blocked) {
    throw new AppError('User is not blocked', 404);
  }

  await prisma.blockedUser.delete({
    where: {
      blockerId_blockedId: {
        blockerId: blockerId,
        blockedId: blockedId,
      },
    },
  });

  return { success: true };
}

// ─── Get Friends List ────────────────────────────────────────────────────────

interface FriendWithStatus {
  id: string;
  friendId: string;
  createdAt: Date;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  online: boolean;
}

export async function getFriendsList(userId: string): Promise<FriendWithStatus[]> {
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [{ userId: userId }, { friendId: userId }],
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
      friend: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
    },
  });

  return friendships.map((friendship) => {
    const isInitiator = friendship.userId === userId;
    const friendUser = isInitiator ? friendship.friend : friendship.user;

    return {
      id: friendship.id,
      friendId: friendUser.id,
      createdAt: friendship.createdAt,
      user: {
        id: friendUser.id,
        username: friendUser.username,
        displayName: friendUser.displayName,
        avatarUrl: friendUser.avatarUrl,
      },
      online: isUserOnline(friendUser.id),
    };
  });
}

// ─── Get Pending Requests ────────────────────────────────────────────────────

export async function getPendingRequests(
  userId: string
): Promise<(FriendRequest & { sender: User })[]> {
  return prisma.friendRequest.findMany({
    where: {
      receiverId: userId,
      status: 'PENDING',
    },
    include: {
      sender: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

// ─── Get Sent Requests ───────────────────────────────────────────────────────

export async function getSentRequests(
  userId: string
): Promise<(FriendRequest & { receiver: User })[]> {
  return prisma.friendRequest.findMany({
    where: {
      senderId: userId,
      status: 'PENDING',
    },
    include: {
      receiver: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

// ─── Are Friends ─────────────────────────────────────────────────────────────

export async function areFriends(
  userId: string,
  otherUserId: string
): Promise<boolean> {
  const friendship = await prisma.friendship.findFirst({
    where: {
      OR: [
        { userId: userId, friendId: otherUserId },
        { userId: otherUserId, friendId: userId },
      ],
    },
  });

  return friendship !== null;
}
