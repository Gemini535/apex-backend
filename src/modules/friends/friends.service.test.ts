import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../config/database.js';
import { clearAllCaches } from '../../shared/cache/index.js';
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
  areFriends,
} from './friends.service.js';

describe('friends.service', () => {
  let aliceId: string;
  let bobId: string;
  let charlieId: string;
  let aliceUsername: string;
  let bobUsername: string;
  let charlieUsername: string;

  beforeAll(async () => {
    const suffix = Date.now().toString();

    const alice = await prisma.user.create({
      data: { email: `alice-${suffix}@test.app`, username: `alice-${suffix}`, passwordHash: 'fake' },
    });
    aliceId = alice.id;
    aliceUsername = alice.username;

    const bob = await prisma.user.create({
      data: { email: `bob-${suffix}@test.app`, username: `bob-${suffix}`, passwordHash: 'fake' },
    });
    bobId = bob.id;
    bobUsername = bob.username;

    const charlie = await prisma.user.create({
      data: { email: `charlie-${suffix}@test.app`, username: `charlie-${suffix}`, passwordHash: 'fake' },
    });
    charlieId = charlie.id;
    charlieUsername = charlie.username;
  });

  beforeEach(async () => {
    // Clean up all friend-related data before each test for isolation
    await prisma.blockedUser.deleteMany();
    await prisma.friendRequest.deleteMany();
    await prisma.friendship.deleteMany();
    clearAllCaches();
  });

  afterAll(async () => {
    await prisma.blockedUser.deleteMany();
    await prisma.friendRequest.deleteMany();
    await prisma.friendship.deleteMany();
    await prisma.user.deleteMany({
      where: { id: { in: [aliceId, bobId, charlieId] } },
    }).catch(() => {});
  });

  describe('sendFriendRequest', () => {
    it('sends a friend request to another user', async () => {
      const request = await sendFriendRequest(aliceId, bobUsername);
      expect(request.senderId).toBe(aliceId);
      expect(request.receiverId).toBe(bobId);
      expect(request.status).toBe('PENDING');
    });

    it('prevents sending a request to yourself', async () => {
      await expect(sendFriendRequest(aliceId, aliceUsername)).rejects.toThrow(
        'Cannot send a friend request to yourself'
      );
    });

    it('prevents sending to a non-existent user', async () => {
      await expect(sendFriendRequest(aliceId, 'nonexistent_user_xyz')).rejects.toThrow(
        'User not found'
      );
    });

    it('prevents duplicate pending requests', async () => {
      await sendFriendRequest(aliceId, bobUsername);
      await expect(sendFriendRequest(aliceId, bobUsername)).rejects.toThrow(
        'A pending friend request already exists'
      );
    });

    it('prevents request when reverse request already exists', async () => {
      await sendFriendRequest(aliceId, bobUsername);
      await expect(sendFriendRequest(bobId, aliceUsername)).rejects.toThrow(
        'A pending friend request already exists'
      );
    });

    it('allows new request after previous was declined', async () => {
      const req = await sendFriendRequest(aliceId, bobUsername);
      await declineFriendRequest(bobId, req.id);
      const newReq = await sendFriendRequest(aliceId, bobUsername);
      expect(newReq.status).toBe('PENDING');
    });

    it('prevents request to a blocked user', async () => {
      await blockUser(charlieId, aliceId);
      await expect(sendFriendRequest(aliceId, charlieUsername)).rejects.toThrow(
        'Cannot send friend request to this user'
      );
    });

    it('prevents request from a blocked user', async () => {
      await blockUser(charlieId, aliceId);
      await expect(sendFriendRequest(charlieId, aliceUsername)).rejects.toThrow(
        'Cannot send friend request to this user'
      );
    });
  });

  describe('acceptFriendRequest', () => {
    it('accepts a pending friend request', async () => {
      const request = await sendFriendRequest(aliceId, bobUsername);
      const friendship = await acceptFriendRequest(bobId, request.id);

      expect(friendship.userId).toBe(aliceId);
      expect(friendship.friendId).toBe(bobId);
      expect(await areFriends(aliceId, bobId)).toBe(true);
    });

    it('prevents accepting your own sent request', async () => {
      const request = await sendFriendRequest(charlieId, aliceUsername);
      await expect(acceptFriendRequest(charlieId, request.id)).rejects.toThrow(
        'You are not the receiver of this request'
      );
    });

    it('prevents accepting a non-existent request', async () => {
      await expect(acceptFriendRequest(aliceId, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
        'Friend request not found'
      );
    });

    it('prevents accepting an already declined request', async () => {
      const request = await sendFriendRequest(aliceId, bobUsername);
      await declineFriendRequest(bobId, request.id);

      await expect(acceptFriendRequest(bobId, request.id)).rejects.toThrow(
        'Friend request is already declined'
      );
    });
  });

  describe('declineFriendRequest', () => {
    it('declines a pending friend request', async () => {
      const request = await sendFriendRequest(charlieId, aliceUsername);
      const result = await declineFriendRequest(aliceId, request.id);
      expect(result.success).toBe(true);

      const updated = await prisma.friendRequest.findUnique({ where: { id: request.id } });
      expect(updated!.status).toBe('DECLINED');
    });

    it('prevents declining someone else request', async () => {
      const request = await sendFriendRequest(aliceId, charlieUsername);
      await expect(declineFriendRequest(bobId, request.id)).rejects.toThrow(
        'You are not the receiver of this request'
      );
    });
  });

  describe('removeFriend', () => {
    it('removes an existing friendship', async () => {
      const request = await sendFriendRequest(aliceId, bobUsername);
      await acceptFriendRequest(bobId, request.id);

      expect(await areFriends(aliceId, bobId)).toBe(true);

      const result = await removeFriend(aliceId, bobId);
      expect(result.success).toBe(true);
      expect(await areFriends(aliceId, bobId)).toBe(false);
    });

    it('throws when no friendship exists', async () => {
      await expect(removeFriend(aliceId, charlieId)).rejects.toThrow('Friendship not found');
    });
  });

  describe('blockUser / unblockUser', () => {
    it('blocks a user and removes existing friendship', async () => {
      // Make them friends first
      const request = await sendFriendRequest(aliceId, bobUsername);
      await acceptFriendRequest(bobId, request.id);
      expect(await areFriends(aliceId, bobId)).toBe(true);

      const result = await blockUser(aliceId, bobId);
      expect(result.success).toBe(true);
      expect(await areFriends(aliceId, bobId)).toBe(false);
    });

    it('prevents blocking yourself', async () => {
      await expect(blockUser(aliceId, aliceId)).rejects.toThrow('Cannot block yourself');
    });

    it('prevents blocking a non-existent user', async () => {
      await expect(blockUser(aliceId, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
        'User not found'
      );
    });

    it('unblocks a blocked user', async () => {
      await blockUser(aliceId, bobId);
      const result = await unblockUser(aliceId, bobId);
      expect(result.success).toBe(true);
    });

    it('throws when unblocking a user that is not blocked', async () => {
      await expect(unblockUser(aliceId, bobId)).rejects.toThrow('User is not blocked');
    });
  });

  describe('getFriendsList', () => {
    it('returns empty list for user with no friends', async () => {
      const friends = await getFriendsList(charlieId);
      expect(friends).toHaveLength(0);
    });

    it('returns friends with correct data', async () => {
      const request = await sendFriendRequest(aliceId, charlieUsername);
      await acceptFriendRequest(charlieId, request.id);

      const friends = await getFriendsList(aliceId);
      expect(friends.length).toBeGreaterThanOrEqual(1);
      const charlieFriend = friends.find((f) => f.friendId === charlieId);
      expect(charlieFriend).toBeDefined();
      expect(charlieFriend!.user.username).toBe(charlieUsername);
    });
  });

  describe('getPendingRequests', () => {
    it('returns pending incoming requests', async () => {
      await sendFriendRequest(bobId, aliceUsername);

      const requests = await getPendingRequests(aliceId);
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(requests[0].senderId).toBe(bobId);
      expect(requests[0].status).toBe('PENDING');
    });

    it('returns empty when no pending requests', async () => {
      const requests = await getPendingRequests(aliceId);
      expect(requests).toHaveLength(0);
    });
  });

  describe('getSentRequests', () => {
    it('returns pending sent requests', async () => {
      await sendFriendRequest(bobId, aliceUsername);

      const requests = await getSentRequests(bobId);
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(requests[0].status).toBe('PENDING');
    });
  });

  describe('areFriends', () => {
    it('returns true for friends', async () => {
      const request = await sendFriendRequest(aliceId, charlieUsername);
      await acceptFriendRequest(charlieId, request.id);
      expect(await areFriends(aliceId, charlieId)).toBe(true);
    });

    it('returns false for non-friends', async () => {
      expect(await areFriends(bobId, charlieId)).toBe(false);
    });
  });
});
