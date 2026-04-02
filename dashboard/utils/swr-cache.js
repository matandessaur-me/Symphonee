/**
 * SWR (Stale-While-Revalidate) Cache
 * Returns cached data immediately while refreshing in background.
 * Notifies listeners when fresh data arrives.
 */

class SWRCache {
  /**
   * @param {object} opts
   * @param {number} opts.staleTTL - How long data is "fresh" (ms). Within this window, cached data is returned without revalidation.
   * @param {number} opts.maxAge - Max age before data is considered too old to serve (ms). After this, we wait for fresh data.
   * @param {function} opts.onRevalidate - Called with (key, newData) when background revalidation completes with different data.
   */
  constructor(opts = {}) {
    this.staleTTL = opts.staleTTL || 30000;    // 30s fresh window
    this.maxAge = opts.maxAge || 300000;        // 5min max age
    this.onRevalidate = opts.onRevalidate || null;
    this._cache = new Map();
    this._inflight = new Map(); // key -> Promise (prevents duplicate fetches)
  }

  /**
   * Get cached data with SWR semantics.
   * @param {string} key - Cache key
   * @param {function} fetcher - Async function that returns fresh data
   * @param {object} opts - Per-request overrides
   * @param {boolean} opts.forceRefresh - Skip cache entirely
   * @returns {Promise<any>} - Data (cached or fresh)
   */
  async get(key, fetcher, opts = {}) {
    const entry = this._cache.get(key);
    const now = Date.now();

    // Force refresh: skip cache, wait for fresh data
    if (opts.forceRefresh) {
      return this._fetchAndStore(key, fetcher);
    }

    // No cache entry: fetch and wait
    if (!entry) {
      return this._fetchAndStore(key, fetcher);
    }

    const age = now - entry.ts;

    // Fresh: return cached data immediately
    if (age < this.staleTTL) {
      return entry.data;
    }

    // Stale but within maxAge: return cached, revalidate in background
    if (age < this.maxAge) {
      this._revalidateBackground(key, fetcher, entry.data);
      return entry.data;
    }

    // Too old: wait for fresh data
    return this._fetchAndStore(key, fetcher);
  }

  /**
   * Set cache data directly (useful after mutations).
   */
  set(key, data) {
    this._cache.set(key, { data, ts: Date.now() });
  }

  /**
   * Invalidate a specific key or all keys matching a prefix.
   */
  invalidate(keyOrPrefix) {
    if (this._cache.has(keyOrPrefix)) {
      this._cache.delete(keyOrPrefix);
      return;
    }
    // Prefix invalidation
    for (const k of this._cache.keys()) {
      if (k.startsWith(keyOrPrefix)) {
        this._cache.delete(k);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear() {
    this._cache.clear();
  }

  /**
   * Get cache stats for diagnostics.
   */
  stats() {
    const entries = [];
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      entries.push({
        key,
        age: now - entry.ts,
        fresh: (now - entry.ts) < this.staleTTL,
      });
    }
    return { size: this._cache.size, entries };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _fetchAndStore(key, fetcher) {
    // Deduplicate: if there's already an in-flight request for this key, wait for it
    if (this._inflight.has(key)) {
      return this._inflight.get(key);
    }

    const promise = Promise.resolve().then(() => fetcher()).then(data => {
      this._cache.set(key, { data, ts: Date.now() });
      this._inflight.delete(key);
      return data;
    }).catch(err => {
      this._inflight.delete(key);
      // On error, return stale data if available
      const stale = this._cache.get(key);
      if (stale) return stale.data;
      throw err;
    });

    this._inflight.set(key, promise);
    return promise;
  }

  _revalidateBackground(key, fetcher, oldData) {
    // Don't start another background fetch if one is already running
    if (this._inflight.has(key)) return;

    const promise = Promise.resolve()
      .then(() => fetcher())
      .then(newData => {
        this._cache.set(key, { data: newData, ts: Date.now() });

        // Notify if data changed (simple JSON comparison)
        if (this.onRevalidate) {
          try {
            const oldJson = JSON.stringify(oldData);
            const newJson = JSON.stringify(newData);
            if (oldJson !== newJson) {
              this.onRevalidate(key, newData);
            }
          } catch (_) {
            // If comparison fails, always notify
            this.onRevalidate(key, newData);
          }
        }
      })
      .catch(() => {
        // Silent fail on background revalidation -- stale data stays
      })
      .finally(() => {
        this._inflight.delete(key);
      });

    this._inflight.set(key, promise);
  }
}

module.exports = { SWRCache };
