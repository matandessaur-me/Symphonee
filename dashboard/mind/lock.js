/**
 * Cross-process Mind operation lock.
 *
 * Prevents concurrent /api/mind/build (or build + watch tick) from racing on
 * graph.json. Uses pure JS (no native deps) so it survives Electron rebuilds.
 *
 * Lock file: <os.tmpdir()>/symphonee-mind-locks/<space>-<op>.lock
 * Format: JSON `{ pid, host, op, space, acquiredAt, refreshedAt }`.
 *
 * Stale threshold: 2 minutes since last refresh. We refresh every 30s while
 * holding the lock so a healthy process never looks stale.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const STALE_MS = 120_000;
const REFRESH_MS = 30_000;
const LOCK_DIR = path.join(os.tmpdir(), 'symphonee-mind-locks');

const heldLocks = new Map();

function ensureDir() {
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch (_) { /* already exists */ }
}

function lockKey(space, op) {
  const safeSpace = String(space || '_global').replace(/[^A-Za-z0-9_-]+/g, '_');
  const safeOp = String(op || 'op').replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${safeSpace}-${safeOp}`;
}

function lockPath(space, op) {
  return path.join(LOCK_DIR, lockKey(space, op) + '.lock');
}

function readLockFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function isAlive(pid) {
  if (!pid || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function isStale(rec) {
  if (!rec) return true;
  if (typeof rec.refreshedAt !== 'number') return true;
  if (Date.now() - rec.refreshedAt > STALE_MS) return true;
  if (!isAlive(rec.pid)) return true;
  return false;
}

function acquire(space, op) {
  ensureDir();
  const key = lockKey(space, op);
  if (heldLocks.has(key)) return { ok: true, alreadyHeld: true };

  const file = lockPath(space, op);
  if (fs.existsSync(file)) {
    const existing = readLockFile(file);
    if (existing && !isStale(existing)) {
      return { ok: false, holderPid: existing.pid || null, holder: existing };
    }
  }

  const rec = {
    pid: process.pid,
    host: os.hostname(),
    op, space,
    acquiredAt: Date.now(),
    refreshedAt: Date.now(),
  };
  try {
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(rec), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const refreshTimer = setInterval(() => {
    try {
      const cur = readLockFile(file);
      if (!cur || cur.pid !== process.pid) {
        clearInterval(refreshTimer);
        heldLocks.delete(key);
        return;
      }
      cur.refreshedAt = Date.now();
      fs.writeFileSync(file, JSON.stringify(cur), 'utf8');
    } catch (_) { /* swallow - released elsewhere */ }
  }, REFRESH_MS);
  refreshTimer.unref?.();

  heldLocks.set(key, { file, refreshTimer });
  return { ok: true, holderPid: process.pid };
}

function release(space, op) {
  const key = lockKey(space, op);
  const held = heldLocks.get(key);
  if (!held) return false;
  clearInterval(held.refreshTimer);
  try { fs.unlinkSync(held.file); } catch (_) { /* already gone */ }
  heldLocks.delete(key);
  return true;
}

function status(space, op) {
  const file = lockPath(space, op);
  if (!fs.existsSync(file)) return { locked: false };
  const rec = readLockFile(file);
  if (!rec || isStale(rec)) return { locked: false, stale: !!rec };
  return {
    locked: true,
    holderPid: rec.pid,
    op: rec.op,
    space: rec.space,
    acquiredAt: rec.acquiredAt,
    refreshedAt: rec.refreshedAt,
    ageMs: Date.now() - rec.acquiredAt,
  };
}

function listAll() {
  ensureDir();
  let entries;
  try { entries = fs.readdirSync(LOCK_DIR); } catch (_) { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.lock')) continue;
    const rec = readLockFile(path.join(LOCK_DIR, f));
    if (!rec) continue;
    out.push({
      file: f, ...rec,
      stale: isStale(rec),
      ageMs: Date.now() - (rec.acquiredAt || 0),
    });
  }
  return out;
}

function terminateHolder(space, op) {
  const file = lockPath(space, op);
  if (!fs.existsSync(file)) return { terminated: false, reason: 'no-lock' };
  const rec = readLockFile(file);
  if (!rec) return { terminated: false, reason: 'unreadable' };
  if (rec.pid === process.pid) return { terminated: false, reason: 'self' };
  if (!isAlive(rec.pid)) {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
    return { terminated: true, reason: 'orphan-cleared', pid: rec.pid };
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${rec.pid}`, { stdio: 'ignore' });
    } else {
      process.kill(rec.pid, 'SIGTERM');
    }
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
    return { terminated: true, reason: 'killed', pid: rec.pid };
  } catch (err) {
    return { terminated: false, reason: 'kill-failed', error: err.message, pid: rec.pid };
  }
}

function releaseAll() {
  for (const key of Array.from(heldLocks.keys())) {
    const held = heldLocks.get(key);
    if (held) {
      clearInterval(held.refreshTimer);
      try { fs.unlinkSync(held.file); } catch (_) { /* ignore */ }
    }
  }
  heldLocks.clear();
}

process.on('exit', releaseAll);

module.exports = {
  acquire,
  release,
  status,
  listAll,
  terminateHolder,
  releaseAll,
  STALE_MS,
};
