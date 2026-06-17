import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

interface SocketUser {
  userId: string;
  email: string;
  username: string;
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
      const payload = jwt.verify(token, env.jwt.secret) as SocketUser;
      (socket as AuthenticatedSocket).user = payload;
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

    // Broadcast online status to friends
    io.emit('friend:online', { userId });

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
          io.emit('friend:offline', { userId });
        }
      }
    });
  });

  return io;
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
