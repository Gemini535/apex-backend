/**
 * Generic in-memory cache with TTL and LRU eviction.
 *
 * One `CacheStore` instance owns a single keyspace. Create one per resource
 * type (brain state, friend list, balance, …). Reads that return `undefined`
 * are the caller's signal to fetch from the database and `set` the result.
 *
 * Eviction policy: least-recently-used, capped at `maxEntries`. Every `get`,
 * `set`, and `del` bumps the key to the most-recently-used position. When the
 * cap is exceeded the oldest key is dropped.
 *
 * Thread safety: JavaScript is single-threaded so no lock needed. The cache
 * is safe to interleave gets/sets across async handlers within one Node process.
 *
 * Graceful degradation: all public methods swallow errors so a cache failure
 * never breaks the request path. Callers always have a fallback (database).
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface CacheOptions {
  /** Per-entry time-to-live in milliseconds. Default 30_000. */
  ttlMs?: number;
  /** Maximum entries retained per keyspace. When exceeded, the least recently
   *  accessed entry is evicted. Default 5_000. */
  maxEntries?: number;
}

export class CacheStore<V> {
  private store = new Map<string, Entry<V>>();
  private accessOrder: string[] = [];
  private disabled = false;

  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 5_000;
  }

  /** Permanently disable this cache (e.g. when CACHE_ENABLED=false). When
   *  disabled, every get returns undefined and every set is a no-op. */
  disable(): void {
    this.disabled = true;
    this.clear();
  }

  /** Returns the cached value if present and not expired, otherwise undefined.
   *  A cache hit promotes the key to most-recently-used. */
  get(key: string): V | undefined {
    if (this.disabled) return undefined;

    try {
      const entry = this.store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        this.del(key);
        return undefined;
      }
      this.bumpAccess(key);
      return entry.value;
    } catch {
      this.disable();
      return undefined;
    }
  }

  /** Caches a value under `key`, replacing any existing entry. The entry
   *  expires after `ttlMs` from now. On success the key becomes most-recently
   *  used. */
  set(key: string, value: V): void {
    if (this.disabled) return;

    try {
      const entry: Entry<V> = { value, expiresAt: Date.now() + this.ttlMs };
      this.store.set(key, entry);
      this.bumpAccess(key);
      this.evictIfNeeded();
    } catch {
      this.disable();
    }
  }

  /** Removes a single entry. No-op on miss. */
  del(key: string): void {
    if (this.disabled) return;

    try {
      this.store.delete(key);
      const idx = this.accessOrder.indexOf(key);
      if (idx !== -1) this.accessOrder.splice(idx, 1);
    } catch {
      this.disable();
    }
  }

  /** Removes every entry whose key starts with `prefix`. Returns count deleted. */
  delByPrefix(prefix: string): number {
    if (this.disabled) return 0;

    try {
      let count = 0;
      for (const key of [...this.store.keys()]) {
        if (key.startsWith(prefix)) {
          this.del(key);
          count++;
        }
      }
      return count;
    } catch {
      this.disable();
      return 0;
    }
  }

  /** Clears the entire keyspace. */
  clear(): void {
    this.store.clear();
    this.accessOrder = [];
  }

  /** No-op if disabled. Exposed for testing. */
  has(key: string): boolean {
    return !this.disabled && this.store.has(key);
  }

  /** Live entry count (ignores expired entries — call get() first to prune). */
  size(): number {
    return this.store.size;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private bumpAccess(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(key);
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxEntries && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift();
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }
}
