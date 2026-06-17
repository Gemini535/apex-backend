import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { initializeSocket } from './shared/websocket/socket.js';

const server = http.createServer(app);

// Initialize Socket.IO
const io = initializeSocket(server);

const PORT = env.port;

server.listen(PORT, () => {
  logger.info(`🚀 Apex backend running on port ${PORT}`);
  logger.info(`   Environment: ${env.nodeEnv}`);
  logger.info(`   Health check: http://localhost:${PORT}/health`);
  logger.info(`   WebSocket: ws://localhost:${PORT}`);
});

// Graceful shutdown
function shutdown(signal: string) {
  logger.info(`${signal} received. Shutting down gracefully...`);
  io.close(() => {
    logger.info('Socket.IO closed');
  });
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Force close after 10s
  setTimeout(() => {
    logger.error('Forced shutdown');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  shutdown('uncaughtException');
});
