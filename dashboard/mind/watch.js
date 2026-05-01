/**
 * Watch mode: hook into a filesystem watcher (chokidar if present, fs.watch
 * fallback otherwise) on the active repo's path and the notes namespace.
 * Debounce 3s, then trigger an incremental update.
 *
 * One watcher per Mind instance. Restartable via setSources().
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE = 3000;
const WATCH_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.cs', '.md', '.mdx',
  '.go', '.java', '.kt', '.kts', '.scala', '.sc', '.rs', '.rb', '.php', '.swift',
  '.css', '.scss', '.sass', '.less', '.styl', '.svelte', '.vue',
  '.json', '.yaml', '.yml',
]);
const SKIP_SEG = /[\\/](node_modules|\.git|\.next|dist|build|out|\.cache|coverage|\.symphonee|\.ai-workspace|__pycache__)([\\/]|$)/;

function tryRequireChokidar() {
  try { return require('chokidar'); } catch (_) { return null; }
}

class MindWatcher {
  constructor({ repoRoot, getUiContext, broadcast, onTrigger, debounceMs = DEFAULT_DEBOUNCE }) {
    this.repoRoot = repoRoot;
    this.getUiContext = getUiContext;
    this.broadcast = broadcast;
    this.onTrigger = onTrigger;
    this.debounceMs = debounceMs;
    this._timer = null;
    this._pending = new Set();
    this._watchers = [];
    this._enabled = false;
  }

  start() {
    if (this._enabled) return;
    this._enabled = true;
    const ui = this.getUiContext ? this.getUiContext() : {};
    const targets = [];
    if (ui.activeRepoPath) targets.push(ui.activeRepoPath);
    const notesNs = ui.notesNamespace || ui.activeSpace || '_global';
    targets.push(path.join(this.repoRoot, 'notes', notesNs));
    targets.push(path.join(this.repoRoot, 'recipes'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'instructions'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'app-recipes'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'app-memory'));
    targets.push(path.join(this.repoRoot, 'dashboard', 'app-recipe-history'));

    const chokidar = tryRequireChokidar();
    if (chokidar) {
      const w = chokidar.watch(targets, {
        ignored: (p) => SKIP_SEG.test(p),
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      });
      w.on('all', (event, p) => this._onEvent(event, p));
      this._watchers.push({ close: () => w.close() });
    } else {
      // fs.watch fallback: shallow per-target watchers, recursive when supported.
      for (const t of targets) {
        if (!fs.existsSync(t)) continue;
        try {
          const w = fs.watch(t, { recursive: true }, (event, fname) => {
            if (!fname) return;
            const full = path.join(t, fname);
            if (SKIP_SEG.test(full)) return;
            this._onEvent(event, full);
          });
          this._watchers.push({ close: () => w.close() });
        } catch (_) { /* recursive not supported on Linux; skip */ }
      }
    }

    if (this.broadcast) this.broadcast({ type: 'mind-update', payload: { kind: 'watch-start', targets } });
  }

  stop() {
    this._enabled = false;
    for (const w of this._watchers) { try { w.close(); } catch (_) {} }
    this._watchers = [];
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending.clear();
  }

  _onEvent(event, fullPath) {
    if (!fullPath) return;
    const ext = path.extname(fullPath).toLowerCase();
    if (!WATCH_EXT.has(ext)) return;
    this._pending.add(fullPath);
    if (this.broadcast) this.broadcast({ type: 'mind-update', payload: { kind: 'watch-trigger', event, file: fullPath } });
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const batch = Array.from(this._pending);
      this._pending.clear();
      this._timer = null;
      try { this.onTrigger && this.onTrigger(batch); } catch (e) { console.warn('[mind/watch] onTrigger error:', e.message); }
    }, this.debounceMs);
  }
}

module.exports = { MindWatcher };
