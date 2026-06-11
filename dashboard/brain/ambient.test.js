'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ambient = require('./ambient');

test('a valuable nudge surfaces at the balanced dial', () => {
  const v = ambient.evaluateNudge({ type: 'cleanup', value: 0.8 }, { dial: 'balanced' });
  assert.equal(v.surface, true);
});

test('the dial controls chattiness: silent suppresses, chatty surfaces the same nudge', () => {
  const c = { type: 'cleanup', value: 0.8 };
  assert.equal(ambient.evaluateNudge(c, { dial: 'silent' }).surface, false);
  assert.equal(ambient.evaluateNudge(c, { dial: 'chatty' }).surface, true);
});

test('trustMultiplier: neutral with no history, decays when dismissed, boosts when accepted', () => {
  assert.equal(ambient.trustMultiplier('x', {}), 1.0);
  assert.equal(ambient.trustMultiplier('x', { x: { accepted: 0, dismissed: 5 } }), 0.25);
  assert.equal(ambient.trustMultiplier('x', { x: { accepted: 5, dismissed: 0 } }), 1.25);
});

test('a repeatedly dismissed suggestion type decays into silence', () => {
  const c = { type: 'figma-tip', value: 0.7 };
  assert.equal(ambient.evaluateNudge(c, { dial: 'balanced', trust: {} }).surface, true);
  const trust = { 'figma-tip': { accepted: 0, dismissed: 9 } };
  const v = ambient.evaluateNudge(c, { dial: 'balanced', trust });
  assert.equal(v.surface, false, 'dismissed type decayed below threshold');
  assert.ok(v.score < 0.55);
});

test('flow-interrupting nudges must clear a high bar regardless of dial', () => {
  // value 0.7 clears the balanced dial (0.55) but NOT the 0.85 flow bar
  const lower = ambient.evaluateNudge({ type: 'a', value: 0.7, interruptsFlow: true }, { dial: 'balanced' });
  assert.equal(lower.surface, false);
  // value 0.9 clears the flow bar
  const higher = ambient.evaluateNudge({ type: 'a', value: 0.9, interruptsFlow: true }, { dial: 'balanced' });
  assert.equal(higher.surface, true);
});

test('applyFeedback reinforces / decays immutably', () => {
  const t1 = ambient.applyFeedback({}, 'x', 'accept');
  assert.deepEqual(t1.x, { accepted: 1, dismissed: 0 });
  const t2 = ambient.applyFeedback(t1, 'x', 'dismiss');
  assert.deepEqual(t2.x, { accepted: 1, dismissed: 1 });
  assert.deepEqual(t1.x, { accepted: 1, dismissed: 0 }, 'original not mutated');
});

test('loadState/saveState round-trip with a default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-ambient-'));
  try {
    assert.deepEqual(ambient.loadState(root), { dial: 'balanced', trust: {}, enabled: true, shown: { types: {}, families: {} } });
    ambient.saveState(root, { dial: 'chatty', trust: { x: { accepted: 2, dismissed: 1 } }, enabled: false });
    const s = ambient.loadState(root);
    assert.equal(s.dial, 'chatty');
    assert.equal(s.trust.x.accepted, 2);
    assert.equal(s.enabled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the novelty gate: the whisper never repeats itself ───────────────────────

test('a once candidate speaks exactly once, ever', () => {
  const c = { type: 'task-success:abc', value: 0.88, once: true };
  let state = { shown: { types: {}, families: {} } };
  assert.equal(ambient.isNovel(c, state), true);
  state = ambient.recordShown(state, c);
  assert.equal(ambient.isNovel(c, state), false, 'same instance never repeats');
  // a DIFFERENT instance of the same family may speak immediately (no cooldown)
  assert.equal(ambient.isNovel({ type: 'task-success:def', value: 0.88, once: true }, state), true);
});

test('a standing candidate is silenced while its fingerprint is unchanged', () => {
  const now = Date.now();
  const c = { type: 'commit-reminder', value: 0.7, fingerprint: 'repo:1' };
  let state = ambient.recordShown({}, c, now);
  // same state, even hours later (within TTL): stay quiet
  assert.equal(ambient.isNovel(c, state, now + 2 * 60 * 60 * 1000), false);
  // the state CHANGED (new fingerprint) and the cooldown passed: speak
  const changed = { type: 'commit-reminder', value: 0.7, fingerprint: 'repo:3' };
  assert.equal(ambient.isNovel(changed, state, now + ambient.FAMILY_COOLDOWN_MS + 1), true);
});

test('a new fingerprint still respects the family cooldown (no flapping)', () => {
  const now = Date.now();
  const state = ambient.recordShown({}, { type: 'inactivity', value: 0.8, fingerprint: 'silence' }, now);
  const next = { type: 'inactivity', value: 0.85, fingerprint: 'unsaved:repo:0' };
  assert.equal(ambient.isNovel(next, state, now + 60 * 1000), false, 'new state but family spoke 1 min ago');
  assert.equal(ambient.isNovel(next, state, now + ambient.FAMILY_COOLDOWN_MS + 1), true, 'cooldown passed');
});

test('delta families (failure/success/mind) have no cooldown between distinct events', () => {
  const now = Date.now();
  const state = ambient.recordShown({}, { type: 'task-failure:a', value: 0.9, once: true }, now);
  assert.equal(ambient.isNovel({ type: 'task-failure:b', value: 0.9, once: true }, state, now + 1000), true);
});

test('shown records expire after the TTL and recordShown prunes them', () => {
  const now = Date.now();
  let state = ambient.recordShown({}, { type: 'offer-summary', value: 0.6, fingerprint: 'x' }, now);
  // past the TTL the same fingerprint may be said again (rotation rewords it)
  assert.equal(ambient.isNovel({ type: 'offer-summary', value: 0.6, fingerprint: 'x' }, state, now + ambient.SHOWN_TTL_MS + 1), true);
  // pruning: recording later drops the stale record
  state = ambient.recordShown(state, { type: 'inactivity', value: 0.8, fingerprint: 's' }, now + ambient.SHOWN_TTL_MS + 1);
  assert.equal(state.shown.families['offer-summary'], undefined, 'stale family pruned');
});

test('shownCounts feeds phrase rotation and recordShown increments it', () => {
  let state = {};
  assert.deepEqual(ambient.shownCounts(state), {});
  state = ambient.recordShown(state, { type: 'inactivity', value: 0.8, fingerprint: 'a' });
  state = ambient.recordShown(state, { type: 'inactivity', value: 0.8, fingerprint: 'b' });
  assert.equal(ambient.shownCounts(state).inactivity, 2);
});

test('familyOf strips the instance suffix', () => {
  assert.equal(ambient.familyOf('task-success:abc123'), 'task-success');
  assert.equal(ambient.familyOf('commit-reminder'), 'commit-reminder');
});

// ── auto-quiet: sustained dismissal turns the whisper down by itself ─────────

test('autoQuiet steps the dial down after a sustained dismissal streak', () => {
  let state = { dial: 'balanced', trust: {}, enabled: true };
  for (let i = 0; i < 8; i++) state = ambient.recordFeedbackEvent(state, 'dismiss');
  state = ambient.autoQuiet(state);
  assert.equal(state.dial, 'reserved');
  assert.equal(state.autoTuned.from, 'balanced');
  assert.deepEqual(state.feedbackLog, [], 'log cleared so one streak cannot cascade');
});

test('autoQuiet stays put on mixed feedback and never goes below silent', () => {
  let state = { dial: 'balanced', trust: {}, enabled: true };
  for (let i = 0; i < 4; i++) state = ambient.recordFeedbackEvent(state, 'dismiss');
  for (let i = 0; i < 4; i++) state = ambient.recordFeedbackEvent(state, 'accept');
  assert.equal(ambient.autoQuiet(state).dial, 'balanced', 'mixed feedback: no change');
  let s2 = { dial: 'silent', trust: {}, enabled: true };
  for (let i = 0; i < 8; i++) s2 = ambient.recordFeedbackEvent(s2, 'dismiss');
  assert.equal(ambient.autoQuiet(s2).dial, 'silent', 'already silent: stays');
});

test('autoQuiet never tunes LOUDER, even on an all-accept streak', () => {
  let state = { dial: 'reserved', trust: {}, enabled: true };
  for (let i = 0; i < 12; i++) state = ambient.recordFeedbackEvent(state, 'accept');
  assert.equal(ambient.autoQuiet(state).dial, 'reserved');
});

test('recordFeedbackEvent caps the log at 20 entries', () => {
  let state = {};
  for (let i = 0; i < 30; i++) state = ambient.recordFeedbackEvent(state, 'accept');
  assert.equal(state.feedbackLog.length, 20);
});

test('shown state survives a save/load round-trip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-ambient-'));
  try {
    let state = ambient.loadState(root);
    state = ambient.recordShown(state, { type: 'task-success:t1', value: 0.88, once: true });
    ambient.saveState(root, state);
    const reloaded = ambient.loadState(root);
    assert.equal(ambient.isNovel({ type: 'task-success:t1', once: true }, reloaded), false, 'memory of what was said survives restart');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
