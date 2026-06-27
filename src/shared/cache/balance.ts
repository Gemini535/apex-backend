/**
 * Token-balance cache.
 *
 * Key: `balance:<userId>` — one entry per user holding their wallet balance as
 * a plain number.
 *
 * Write path: every writer that credits or debits tokens (via
 * `creditTokens` / `debitTokens` in tokens.service.ts, plus writers in
 * wheel.service.ts and pools.service.ts) calls `invalidateBalance(userId)`
 * immediately after committing a successful write. The invariant is:
 *   "invalidate on the same code path that did the Prisma write."
 *
 * Read path: `getBalance` in tokens.service.ts reads from cache first.
 */

import { CacheStore } from './store.js';

const PREFIX = 'balance';
const TTL_MS = Number(process.env.CACHE_TTL_BALANCE_MS ?? 60_000);

const cache = new CacheStore<number>({ ttlMs: TTL_MS });

if (process.env.CACHE_ENABLED === 'false') {
  cache.disable();
}

function key(userId: string): string {
  return `${PREFIX}:${userId}`;
}

export function getCachedBalance(userId: string): number | undefined {
  return cache.get(key(userId));
}

export function setCachedBalance(userId: string, balance: number): void {
  cache.set(key(userId), balance);
}

export function invalidateBalance(userId: string): void {
  cache.del(key(userId));
}

export function clearBalanceCache(): void {
  cache.clear();
}

export { cache as balanceCache };
