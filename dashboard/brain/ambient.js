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
 *   4. NEVER REPEAT YOURSELF (the novelty gate). A colleague does not say the
 *      same sentence twice while nothing changed. Three mechanisms:
 *        - `once` candidates (a specific task, a specific memory card) speak
 *          exactly once, ever - keyed by full type.
 *        - standing candidates carry a `fingerprint` of the state they
 *          describe; the same fingerprint is never spoken twice.
 *        - even with a NEW fingerprint, a family stays quiet through its
 *          cooldown window, so a slow-changing state does not flap.
 *      Delta families (task-failure / task-success / mind-delta) have no
 *      cooldown - each genuinely new event may speak immediately.
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

// ── the novelty gate (rule 4) ────────────────────────────────────────────────

// How long a FAMILY stays quiet after speaking, even if its state changed.
// Delta families react to discrete fresh events - no cooldown; their `once`
// instance keys prevent repeats instead.
const FAMILY_COOLDOWN_MS = 30 * 60 * 1000;
const NO_COOLDOWN_FAMILIES = new Set(['task-failure', 'task-success', 'mind-delta']);
// Shown records older than this are forgotten (a day later, repeating a still
// true observation once is acceptable - and phrase rotation rewords it anyway).
const SHOWN_TTL_MS = 24 * 60 * 60 * 1000;

function familyOf(type) { return String(type || '').split(':')[0]; }

function _shown(state) {
  const s = (state && state.shown) || {};
  return { types: s.types || {}, families: s.families || {} };
}

/**
 * Is this candidate something the whisper has NOT already said?
 * Pure: reads state, never writes.
 */
function isNovel(candidate, state, now = Date.now()) {
  if (!candidate || !candidate.type) return false;
  const shown = _shown(state);
  // Instance candidates (once): exactly one utterance, ever.
  if (candidate.once && shown.types[candidate.type]) return false;
  const fam = familyOf(candidate.type);
  const f = shown.families[fam];
  if (!f || (now - f.at > SHOWN_TTL_MS)) return true;
  // Same state already described -> stay silent until the state changes.
  if (candidate.fingerprint != null && f.fingerprint === candidate.fingerprint) return false;
  // New state, but the family spoke recently -> respect the cooldown.
  if (!NO_COOLDOWN_FAMILIES.has(fam) && (now - f.at < FAMILY_COOLDOWN_MS)) return false;
  return true;
}

/**
 * Record that a candidate was actually surfaced (immutable; returns new state).
 * Also prunes shown records past their TTL so ambient.json stays small.
 */
function recordShown(state, candidate, now = Date.now()) {
  const next = { ...(state || {}) };
  const shown = _shown(next);
  const types = {};
  for (const [k, v] of Object.entries(shown.types)) if (now - v <= SHOWN_TTL_MS) types[k] = v;
  const families = {};
  for (const [k, v] of Object.entries(shown.families)) if (v && now - v.at <= SHOWN_TTL_MS) families[k] = v;
  if (candidate && candidate.type) {
    if (candidate.once) types[candidate.type] = now;
    const fam = familyOf(candidate.type);
    const prev = families[fam];
    families[fam] = {
      at: now,
      fingerprint: candidate.fingerprint != null ? candidate.fingerprint : null,
      count: ((prev && prev.count) || 0) + 1,
    };
  }
  next.shown = { types, families };
  return next;
}

/** Per-family utterance counts - drives deterministic phrase rotation in rules. */
function shownCounts(state) {
  const out = {};
  for (const [fam, v] of Object.entries(_shown(state).families)) out[fam] = (v && v.count) || 0;
  return out;
}

// ── tiny file-backed store (trust + dial + shown), like outcomes.js ──────────

function _file(repoRoot) { return path.join(repoRoot, '.symphonee', 'ambient.json'); }

function loadState(repoRoot) {
  try {
    const s = JSON.parse(fs.readFileSync(_file(repoRoot), 'utf8'));
    return { dial: DEFAULT_DIAL, trust: {}, enabled: true, shown: { types: {}, families: {} }, ...s };
  } catch (_) { return { dial: DEFAULT_DIAL, trust: {}, enabled: true, shown: { types: {}, families: {} } }; }
}
function saveState(repoRoot, state) {
  const file = _file(repoRoot);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
  fs.writeFileSync(file, JSON.stringify({
    dial: state.dial || DEFAULT_DIAL,
    trust: state.trust || {},
    enabled: state.enabled !== false,   // hard on/off; default on
    shown: _shown(state),               // what was already said (novelty gate)
  }, null, 2), 'utf8');
}

module.exports = {
  DIALS, DEFAULT_DIAL, FLOW_INTERRUPT_BAR,
  FAMILY_COOLDOWN_MS, SHOWN_TTL_MS,
  trustMultiplier, evaluateNudge, applyFeedback,
  familyOf, isNovel, recordShown, shownCounts,
  loadState, saveState,
};
