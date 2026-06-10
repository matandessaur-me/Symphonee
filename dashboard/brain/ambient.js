/**
 * The ambient brain - Stage 6 (Jarvis, done right).
 *
 * Proactive nudges that feel futuristic, not Clippy. Three rules from the plan,
 * all implemented here:
 *   1. TRIGGER on signal, not a timer. evaluateNudge() is called when a real
 *      signal fires (an intent change, a fresh consolidation insight, a
 *      prediction-error) - never on a clock.
 *   2. GATE on value with a user-tunable silent<->chatty DIAL. A nudge surfaces
 *      only if its (trust-adjusted) value clears the dial's threshold, and
 *      NEVER interrupts mid-flow below a high bar.
 *   3. EARN trust via accept/dismiss. Suggestion TYPES that get dismissed decay
 *      (their value is multiplied down); accepted types are reinforced. This is
 *      the Hebbian "use it or lose it" the plan asked for, applied to nudge
 *      types instead of synapses.
 *
 * Pure decision core + a small file-backed trust/dial store, mirroring
 * outcomes.js. No timers, no LLM - the value judgement is deterministic.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// The dial: higher threshold = more silent. The user turns this.
const DIALS = { silent: 0.9, reserved: 0.75, balanced: 0.55, chatty: 0.35 };
const DEFAULT_DIAL = 'balanced';
// A nudge that would interrupt active flow must clear this regardless of dial.
const FLOW_INTERRUPT_BAR = 0.85;

function _clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/**
 * Trust multiplier for a suggestion type given accept/dismiss history.
 * No history -> 1.0 (neutral). All-accepted -> up to ~1.25 (reinforced).
 * All-dismissed -> down to ~0.25 (decayed toward silence).
 */
function trustMultiplier(type, trust = {}) {
  const t = trust[type];
  if (!t || (t.accepted || 0) + (t.dismissed || 0) === 0) return 1.0;
  const total = t.accepted + t.dismissed;
  const ratio = t.accepted / total; // 0..1
  return Math.round((0.25 + ratio) * 1000) / 1000; // 0.25 .. 1.25
}

/**
 * Decide whether a candidate nudge should surface.
 * @param candidate { type, value: 0..1, interruptsFlow?: boolean, title?, detail? }
 * @param opts      { dial?: string, trust?: object }
 * @returns { surface, score, threshold, reason, multiplier }
 */
function evaluateNudge(candidate, opts = {}) {
  const dial = DIALS[opts.dial] != null ? opts.dial : DEFAULT_DIAL;
  const threshold = DIALS[dial];
  const mult = trustMultiplier(candidate.type, opts.trust || {});
  const score = Math.round(_clamp01((candidate.value || 0) * mult) * 1000) / 1000;

  if (candidate.interruptsFlow && score < FLOW_INTERRUPT_BAR) {
    return { surface: false, score, threshold, multiplier: mult, reason: `would interrupt flow; ${score} < ${FLOW_INTERRUPT_BAR} bar` };
  }
  const surface = score >= threshold;
  return {
    surface, score, threshold, multiplier: mult,
    reason: surface
      ? `value ${score} >= ${dial} threshold ${threshold}`
      : `value ${score} < ${dial} threshold ${threshold}; stay quiet`,
  };
}

/**
 * Apply accept/dismiss feedback to a trust object (immutable; returns a copy).
 * 'accept' reinforces the type, 'dismiss' decays it.
 */
function applyFeedback(trust, type, action) {
  const next = { ...(trust || {}) };
  const cur = next[type] ? { ...next[type] } : { accepted: 0, dismissed: 0 };
  if (action === 'accept') cur.accepted += 1;
  else if (action === 'dismiss') cur.dismissed += 1;
  next[type] = cur;
  return next;
}

// ── tiny file-backed store (trust + dial), like outcomes.js ──────────────────

function _file(repoRoot) { return path.join(repoRoot, '.symphonee', 'ambient.json'); }

function loadState(repoRoot) {
  try {
    const s = JSON.parse(fs.readFileSync(_file(repoRoot), 'utf8'));
    return { dial: DEFAULT_DIAL, trust: {}, enabled: true, ...s };
  } catch (_) { return { dial: DEFAULT_DIAL, trust: {}, enabled: true }; }
}
function saveState(repoRoot, state) {
  const file = _file(repoRoot);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
  fs.writeFileSync(file, JSON.stringify({
    dial: state.dial || DEFAULT_DIAL,
    trust: state.trust || {},
    enabled: state.enabled !== false,   // hard on/off; default on
  }, null, 2), 'utf8');
}

module.exports = {
  DIALS, DEFAULT_DIAL, FLOW_INTERRUPT_BAR,
  trustMultiplier, evaluateNudge, applyFeedback,
  loadState, saveState,
};
