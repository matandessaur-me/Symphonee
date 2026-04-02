/**
 * Busy Guard
 * Prevents concurrent operations on shared resources.
 * Used for work item mutations, PR creation, git operations, etc.
 */

class BusyGuard {
  constructor() {
    this._locks = new Map(); // resource -> { operation, startTime, timeout }
  }

  /**
   * Check if a resource is currently busy.
   * @param {string} resource - Resource identifier (e.g., 'workitem:12345', 'git:checkout')
   * @returns {boolean}
   */
  isBusy(resource) {
    const lock = this._locks.get(resource);
    if (!lock) return false;
    // Auto-expire stale locks
    if (Date.now() - lock.startTime > lock.timeout) {
      this._locks.delete(resource);
      return false;
    }
    return true;
  }

  /**
   * Get the current operation name for a busy resource.
   */
  getOperation(resource) {
    const lock = this._locks.get(resource);
    return lock ? lock.operation : null;
  }

  /**
   * Acquire a lock on a resource. Throws if already busy.
   * @param {string} resource - Resource identifier
   * @param {string} operation - Human-readable operation name
   * @param {number} timeoutMs - Auto-expire timeout (default 30s)
   * @returns {function} release - Call this to release the lock
   */
  acquire(resource, operation, timeoutMs = 30000) {
    if (this.isBusy(resource)) {
      const current = this.getOperation(resource);
      throw new Error(`Resource busy: ${current}. Please wait before trying again.`);
    }

    const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    this._locks.set(resource, {
      operation,
      startTime: Date.now(),
      timeout: timeoutMs,
      token,
    });

    // Return a release function that only deletes if the token still matches
    let released = false;
    return () => {
      if (!released) {
        released = true;
        const current = this._locks.get(resource);
        if (current && current.token === token) {
          this._locks.delete(resource);
        }
      }
    };
  }

  /**
   * Execute an async function with a busy guard.
   * Automatically acquires and releases the lock.
   * @param {string} resource - Resource identifier
   * @param {string} operation - Operation name
   * @param {function} fn - Async function to execute
   * @param {number} timeoutMs - Lock timeout
   * @returns {Promise<any>}
   */
  async run(resource, operation, fn, timeoutMs = 30000) {
    const release = this.acquire(resource, operation, timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Get all active locks (for diagnostics).
   */
  activeLocks() {
    const result = [];
    const now = Date.now();
    for (const [resource, lock] of this._locks) {
      if (now - lock.startTime < lock.timeout) {
        result.push({
          resource,
          operation: lock.operation,
          elapsed: now - lock.startTime,
        });
      } else {
        this._locks.delete(resource);
      }
    }
    return result;
  }
}

module.exports = { BusyGuard };
