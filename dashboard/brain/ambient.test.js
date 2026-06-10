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
    assert.deepEqual(ambient.loadState(root), { dial: 'balanced', trust: {}, enabled: true });
    ambient.saveState(root, { dial: 'chatty', trust: { x: { accepted: 2, dismissed: 1 } }, enabled: false });
    const s = ambient.loadState(root);
    assert.equal(s.dial, 'chatty');
    assert.equal(s.trust.x.accepted, 2);
    assert.equal(s.enabled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
