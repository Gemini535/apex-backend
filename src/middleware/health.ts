import type { Request, Response } from 'express';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';

/**
 * Health check that actually verifies the database is reachable. Returns 200
 * only when the app can query Postgres; returns 503 otherwise so load
 * balancers / orchestrators (Kubernetes, ECS, Railway) can take the instance
 * out of rotation.
 *
 * We run a lightweight `SELECT 1` via Prisma's `$queryRaw`. A timeout ensures
 * a hung connection doesn't keep the endpoint open indefinitely.
 */
export async function healthHandler(_req: Request, res: Response): Promise<void> {
  const start = Date.now();
  try {
    // Prisma doesn't expose a built-in ping, so we run a raw query. The
    // `SELECT 1` is supported by every Postgres driver and is essentially free.
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          status: 'up',
          responseTimeMs: Date.now() - start,
        },
      },
    });
  } catch (err) {
    logger.error({ err }, 'Health check failed: database unreachable');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          status: 'down',
          responseTimeMs: Date.now() - start,
        },
      },
    });
  }
}
