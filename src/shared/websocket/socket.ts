import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../config/database.js';

interface SocketUser {
  userId: string;
  email: string;
  username: string;
}

/** Raw decoded shape of the access-token JWT (see middleware/auth.ts). */
interface AccessTokenClaims extends SocketUser {
  type?: string;
  sid?: string;
}

interface AuthenticatedSocket extends Socket {
  user: SocketUser;
}

// Track online users: userId -> Set of socket IDs
const onlineUsers = new Map<string, Set<string>>();

let io: Server;

export function initializeSocket(server: HttpServer): Server {
  io = new Server(server, {
    cors: {
      origin: '*', // Restrict in production
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
  });

  // Auth middleware
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      // Pin the algorithm (see middleware/auth.ts for the same rationale)
      // and reject anything that isn't a genuine access token — e.g. the
      // 2FA temp token, which is now signed with a different secret
      // entirely, so it would already fail the signature check above, but
      // the explicit `type` check keeps this consistent with
      // authenticateToken as defense in depth.
      const payload = jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'] }) as AccessTokenClaims;
      if (payload.type !== 'access') {
        return next(new Error('Invalid token'));
      }
      (socket as AuthenticatedSocket).user = {
        userId: payload.userId,
        email: payload.email,
        username: payload.username,
      };
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const authSocket = socket as AuthenticatedSocket;
    const { userId, username } = authSocket.user;

    logger.info({ userId, username, socketId: socket.id }, 'User connected');

    // Track online presence
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId)!.add(socket.id);

    // Broadcast online status to friends (fire and forget)
    void broadcastPresence(userId, 'friend:online', { userId });

    // ─── Screen Time Events ──────────────────────────────────────────────

    socket.on('screentime:start', (data: {
      appName: string;
      appBundleId?: string;
      category: string;
      timestamp: string;
    }) => {
      logger.debug({ userId, ...data }, 'Screen time start');
      // Broadcast to friends who have visible status enabled
      socket.broadcast.emit('friend:screentime_start', {
        userId,
        appName: data.appName,
        category: data.category,
        timestamp: data.timestamp,
      });
    });

    socket.on('screentime:stop', (data: {
      appName: string;
      duration: number;
      timestamp: string;
    }) => {
      logger.debug({ userId, ...data }, 'Screen time stop');
    });

    socket.on('screentime:threshold_alert', (data: {
      category: string;
      percentUsed: number;
    }) => {
      logger.info({ userId, ...data }, 'Screen time threshold alert');
    });

    // ─── Disconnect ──────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      logger.info({ userId, username, socketId: socket.id }, 'User disconnected');

      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          void broadcastPresence(userId, 'friend:offline', { userId });
        }
      }
    });
  });

  return io;
}

/**
 * Looks up a user's friends from the database (both directions of the
 * Friendship relation) and broadcasts an event to only the socket IDs of
 * online friends. This replaces the old io.emit broadcast, which notified
 * every connected client.
 */
async function broadcastPresence(
  userId: string,
  event: string,
  data: unknown,
): Promise<void> {
  try {
    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ userId }, { friendId: userId }] },
      select: { userId: true, friendId: true },
    });

    const friendIds = friendships.map((f) =>
      f.userId === userId ? f.friendId : f.userId,
    );

    for (const friendId of friendIds) {
      emitToUser(friendId, event, data);
    }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to broadcast presence');
  }
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
}

export function isUserOnline(userId: string): boolean {
  return onlineUsers.has(userId) && onlineUsers.get(userId)!.size > 0;
}

export function getOnlineFriends(friendIds: string[]): string[] {
  return friendIds.filter((id) => isUserOnline(id));
}

export function emitToUser(userId: string, event: string, data: unknown): void {
  const sockets = onlineUsers.get(userId);
  if (sockets) {
    sockets.forEach((socketId) => {
      io.to(socketId).emit(event, data);
    });
  }
}
