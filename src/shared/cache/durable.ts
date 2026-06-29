/**
 * Durable key-value cache backed by Postgres.
 *
 * Replaces in-memory Map stores that evaporate on restart and break horizontal
 * scaling. Used for:
 *   - SMS / email verification codes (5-minute TTL)
 *   - Stripe idempotency keys (24-hour TTL)
 *
 * TTL is enforced via an `expiresAt` column. Expired rows are treated as cache
 * misses by readers and cleaned up by the `cache-cleanup` pg-boss job.
 *
 * The API mirrors the old Map-based stores so callers change minimally:
 *   cacheSet(key, value, ttlMs)  →  store with expiration
 *   cacheGet<T>(key)            →  return value or undefined
 *   cacheDel(key)               →  remove entry
 */

import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Store a value with a TTL. Overwrites any existing entry for `key`.
 * The value is JSON-serialized before storage.
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);

  try {
    await prisma.cacheEntry.upsert({
      where: { key },
      create: { key, value: JSON.stringify(value), expiresAt },
      update: { value: JSON.stringify(value), expiresAt },
    });
  } catch (err) {
    // Cache write failures must never break the request path. Log and continue.
    logger.error({ err, key }, 'cacheSet failed');
  }
}

/**
 * Retrieve a value. Returns `undefined` if the key is missing or expired.
 * Expired rows are deleted on read (lazy cleanup).
 */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const row = await prisma.cacheEntry.findUnique({ where: { key } });

    if (!row) return undefined;

    if (Date.now() > row.expiresAt.getTime()) {
      // Expired — delete lazily and treat as miss.
      await cacheDel(key);
      return undefined;
    }

    return JSON.parse(row.value) as T;
  } catch (err) {
    logger.error({ err, key }, 'cacheGet failed');
    return undefined;
  }
}

/**
 * Delete a cache entry. Idempotent — no error if the key doesn't exist.
 */
export async function cacheDel(key: string): Promise<void> {
  try {
    await prisma.cacheEntry.delete({ where: { key } });
  } catch (err) {
    // "Record to delete does not exist" is expected; ignore it.
    if ((err as { code?: string })?.code !== 'P2025') {
      logger.error({ err, key }, 'cacheDel failed');
    }
  }
}

// ─── Maintenance ────────────────────────────────────────────────────────────────

/**
 * Deletes all expired cache entries. Called by the `cache-cleanup` pg-boss job
 * every 30 minutes. Also useful for manual cleanup scripts.
 */
export async function cleanupExpiredCache(): Promise<number> {
  try {
    const result = await prisma.cacheEntry.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });

    if (result.count > 0) {
      logger.info({ deleted: result.count }, 'Expired cache entries cleaned up');
    }

    return result.count;
  } catch (err) {
    logger.error({ err }, 'cleanupExpiredCache failed');
    return 0;
  }
}
