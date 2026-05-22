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

function read(repoRoot) {
  const file = intentFile(repoRoot);
  try {
    if (!fs.existsSync(file)) return emptyIntent();
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyIntent(), ...parsed };
  } catch (_) {
    return emptyIntent();
  }
}

function write(repoRoot, state) {
  const file = intentFile(repoRoot);
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
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
    if (inFlight && !force) return;
    if (pausedReason && !force) return;
    inFlight = true;
    const batch = pendingEvidence.slice();
    pendingEvidence = [];
    try {
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
      if (broadcast) {
        broadcast({ type: 'symphonee-intent', payload: { summary: next.summary, confidence: next.confidence, currentRepo: next.currentRepo } });
      }
      return next;
    } catch (err) {
      console.warn('[brain/intent] recompute error:', err.message);
    } finally {
      inFlight = false;
    }
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
