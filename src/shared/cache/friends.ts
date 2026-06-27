/**
 * Friend-list cache.
 *
 * Key: `friends:<userId>` — one entry per user holding their full friend list
 * (with online status). A short TTL (30 s) bounds staleness; every friend
 * mutation invalidates the entry immediately so the next read repopulates.
 *
 * Write path: every writer in friends.service calls `invalidateFriends(userId)`
 * after a successful mutation.
 *
 * Read path: `getFriendsList`, `getPendingRequests`, `getSentRequests` in
 * friends.service read from cache first.
 */

import { CacheStore } from './store.js';

const PREFIX = 'friends';
const TTL_MS = Number(process.env.CACHE_TTL_FRIENDS_MS ?? 30_000);

// Three independent caches — one per read shape — so that a mutation that only
// affects one shape (e.g. a pending request) doesn't evict the others.
const friendsCache = new CacheStore<unknown[]>({ ttlMs: TTL_MS });
const pendingCache = new CacheStore<unknown[]>({ ttlMs: TTL_MS });
const sentCache = new CacheStore<unknown[]>({ ttlMs: TTL_MS });

if (process.env.CACHE_ENABLED === 'false') {
  friendsCache.disable();
  pendingCache.disable();
  sentCache.disable();
}

function key(userId: string): string {
  return `${PREFIX}:${userId}`;
}

// ─── Friends list ─────────────────────────────────────────────────────────────

export function getFriends(userId: string): unknown[] | undefined {
  return friendsCache.get(key(userId));
}

export function setFriends(userId: string, friends: unknown[]): void {
  friendsCache.set(key(userId), friends);
}

// ─── Pending requests ─────────────────────────────────────────────────────────

export function getPending(userId: string): unknown[] | undefined {
  return pendingCache.get(key(userId));
}

export function setPending(userId: string, requests: unknown[]): void {
  pendingCache.set(key(userId), requests);
}

// ─── Sent requests ────────────────────────────────────────────────────────────

export function getSent(userId: string): unknown[] | undefined {
  return sentCache.get(key(userId));
}

export function setSent(userId: string, requests: unknown[]): void {
  sentCache.set(key(userId), requests);
}

// ─── Invalidation ─────────────────────────────────────────────────────────────

/** Drops all three cached reads for a single user. Call after any friend
 *  mutation (send/accept/decline/unfriend/block/unblock). */
export function invalidateFriends(userId: string): void {
  friendsCache.del(key(userId));
  pendingCache.del(key(userId));
  sentCache.del(key(userId));
}

/** Drops every user's friend cache. */
export function clearFriendsCache(): void {
  friendsCache.clear();
  pendingCache.clear();
  sentCache.clear();
}
