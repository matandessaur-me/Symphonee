/**
 * Symphonee intent state - the live theory of what the user is doing.
 *
 * Lives as a single JSON file at .symphonee/intent.json so it survives Mind
 * rebuilds and is readable without loading the full graph. One global intent
 * record (Symphonee-wide), with a currentRepo field inside it - the user
 * works across repos in the same session.
 *
 * Update is event-driven, not time-driven (the user does not keep the
 * machine on between sessions; see memory_mpgx8n15_f64mb3). Callers fire
 * intent.update() from existing event hooks: watch, drawer turns,
 * save-result, git activity. We debounce internally so a burst of file
 * events does not thrash gemma.
 *
 * The actual reasoning - reading recent events and producing a one-sentence
 * intent summary - happens in brain/planner.js. This module owns the state
 * and the debounce; the planner owns the LLM call.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const perf = require('./perf');

const DEBOUNCE_MS = 5000;
const MAX_EVIDENCE = 12;

function intentFile(repoRoot) {
  return path.join(repoRoot, '.symphonee', 'intent.json');
}

function ensureDir(file) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function emptyIntent() {
  return {
    version: 1,
    summary: null,
    confidence: 0,
    currentRepo: null,
    lastUpdated: null,
    lastEventAt: null,
    evidence: [],
    history: [],
    updateCount: 0,
  };
}

// In-memory mirror of the latest intent state. brain.getIntent() is on the
// hot path of every plan/answer/synthesize call - without a cache that's
// a fs.readFileSync per call. Population: lazy on first read, then
// updated whenever write() runs.
const _stateCache = new Map(); // repoRoot -> state

function read(repoRoot) {
  if (_stateCache.has(repoRoot)) {
    perf.bump('intent.cache.hit');
    return _stateCache.get(repoRoot);
  }
  perf.bump('intent.cache.miss');
  const file = intentFile(repoRoot);
  let state = emptyIntent();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      state = { ...emptyIntent(), ...parsed };
    }
  } catch (_) { /* fall through to empty */ }
  _stateCache.set(repoRoot, state);
  return state;
}

function write(repoRoot, state) {
  const file = intentFile(repoRoot);
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  _stateCache.set(repoRoot, state);
  return state;
}

/**
 * Create an intent manager bound to a repoRoot. Callers register an
 * onRecompute callback that receives the pending evidence list and returns
 * a promise resolving to { summary, confidence, currentRepo }. The manager
 * persists the result and broadcasts.
 */
function createIntentManager({ repoRoot, onRecompute, broadcast, getUiContext }) {
  let pendingEvidence = [];
  let pendingTimer = null;
  let inFlight = false;
  let pausedReason = null;

  function _pushEvidence(ev) {
    pendingEvidence.push({ ...ev, at: Date.now() });
    if (pendingEvidence.length > MAX_EVIDENCE) {
      pendingEvidence = pendingEvidence.slice(-MAX_EVIDENCE);
    }
  }

  async function _recompute(force = false) {
    // If a recompute is already running (gemma can take 30+ s), we
    // skip this call. The events we would have processed STAY in
    // pendingEvidence so the post-run drain picks them up. Without
    // this, events arriving during a gemma run got silently dropped.
    if (inFlight && !force) return;
    if (pausedReason && !force) return;
    inFlight = true;
    let writtenState = null;
    try {
      // Pull whatever is queued NOW. New events that arrive while
      // onRecompute is running stay in pendingEvidence and are
      // handled by the post-run drain below.
      const batch = pendingEvidence.slice();
      pendingEvidence = [];
      if (!batch.length && !force) return;
      const ui = getUiContext ? getUiContext() : {};
      const current = read(repoRoot);
      const result = await onRecompute({
        repoRoot,
        ui,
        current,
        evidence: batch,
      });
      if (!result) return;
      const next = {
        ...current,
        summary: result.summary || current.summary,
        confidence: typeof result.confidence === 'number' ? result.confidence : current.confidence,
        currentRepo: result.currentRepo || ui.activeRepo || current.currentRepo,
        lastUpdated: new Date().toISOString(),
        lastEventAt: batch.length ? new Date(batch[batch.length - 1].at).toISOString() : current.lastEventAt,
        evidence: batch.slice(-MAX_EVIDENCE),
        history: [...(current.history || []), {
          summary: result.summary,
          confidence: result.confidence,
          at: new Date().toISOString(),
        }].slice(-20),
        updateCount: (current.updateCount || 0) + 1,
      };
      write(repoRoot, next);
      writtenState = next;
      if (broadcast) {
        broadcast({ type: 'symphonee-intent', payload: { summary: next.summary, confidence: next.confidence, currentRepo: next.currentRepo } });
      }
    } catch (err) {
      console.warn('[brain/intent] recompute error:', err.message);
    } finally {
      inFlight = false;
      // Drain: if new events arrived during the run, schedule another
      // recompute. We use the debounce timer so a burst still
      // coalesces; setting timer to fire immediately would thrash gemma.
      if (pendingEvidence.length > 0 && !pendingTimer && !pausedReason) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          _recompute().catch(() => {});
        }, DEBOUNCE_MS);
      }
    }
    return writtenState;
  }

  function notify(evidence) {
    if (!evidence) return;
    _pushEvidence(evidence);
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      _recompute().catch(() => {});
    }, DEBOUNCE_MS);
  }

  function get() {
    return read(repoRoot);
  }

  function pause(reason = 'manual') { pausedReason = reason; }
  function resume() { pausedReason = null; }

  async function forceRecompute() {
    return _recompute(true);
  }

  function pendingCount() { return pendingEvidence.length; }

  return { notify, get, pause, resume, forceRecompute, pendingCount };
}

module.exports = {
  createIntentManager,
  emptyIntent,
  read,
  write,
  intentFile,
};
