/**
 * Per-space file manifest: path -> { sha256, lastExtractedAt, contributors }.
 *
 * Phase 1 uses a JSON-backed manifest for portability (no native module
 * rebuild required against Electron's Node ABI). When the manifest grows
 * past ~5k entries the natural upgrade is better-sqlite3 with the same
 * surface API; the rest of the engine doesn't need to know.
 *
 * The manifest is the hot table: it gets touched on every save, so we
 * write it lazily (debounced) to avoid file thrash.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spaceDir, ensureDirs } = require('./store');

const FLUSH_DEBOUNCE_MS = 500;

function manifestPath(repoRoot, space) {
  return path.join(spaceDir(repoRoot, space), 'manifest.json');
}

class Manifest {
  constructor(repoRoot, space) {
    this.repoRoot = repoRoot;
    this.space = space;
    this.entries = new Map();
    this._dirty = false;
    this._flushTimer = null;
    this._load();
  }

  _load() {
    ensureDirs(this.repoRoot, this.space);
    const p = manifestPath(this.repoRoot, this.space);
    if (!fs.existsSync(p)) return;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [k, v] of Object.entries(data.entries || {})) this.entries.set(k, v);
    } catch (_) { /* corrupt manifest — start fresh, we'll reseed from cache */ }
  }

  _scheduleFlush() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this._dirty) this.flushSync();
    }, FLUSH_DEBOUNCE_MS);
  }

  flushSync() {
    if (!this._dirty) return;
    const out = { entries: Object.fromEntries(this.entries) };
    fs.writeFileSync(manifestPath(this.repoRoot, this.space), JSON.stringify(out, null, 2), 'utf8');
    this._dirty = false;
  }

  get(filePath) { return this.entries.get(filePath) || null; }

  set(filePath, { sha256, lastExtractedAt, contributors }) {
    this.entries.set(filePath, {
      sha256,
      lastExtractedAt: lastExtractedAt || Date.now(),
      contributors: contributors || [],
    });
    this._scheduleFlush();
  }

  delete(filePath) {
    if (this.entries.delete(filePath)) this._scheduleFlush();
  }

  paths() { return Array.from(this.entries.keys()); }

  staleness(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    return this.paths().filter(p => (this.entries.get(p)?.lastExtractedAt || 0) < cutoff);
  }
}

function hashContent(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashFile(filePath) {
  return hashContent(fs.readFileSync(filePath));
}

module.exports = { Manifest, hashContent, hashFile };
