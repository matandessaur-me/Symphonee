'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const conductor = require('./conductor');

const plan = (intent, { triageConfidence, escalated = false } = {}) => ({
  ok: true, escalated,
  triageConfidence,
  decision: { intent, confidence: triageConfidence },
});

test('tool-bound intents recommend rung 3 (frontier)', () => {
  for (const intent of ['code-action', 'code-question', 'plan', 'browse-files', 'apps-action', 'browser-action', 'plugin-call']) {
    const r = conductor.recommendRung(plan(intent, { triageConfidence: 0.9 }));
    assert.equal(r.rung, 3, `${intent} -> rung 3`);
  }
});

test('greeting recommends rung 1', () => {
  assert.equal(conductor.recommendRung(plan('greeting', { triageConfidence: 0.95 })).rung, 1);
});

test('recall recommends rung 1 when Mind can ground', () => {
  const r = conductor.recommendRung(plan('recall', { triageConfidence: 0.8 }), { mindCanGround: true });
  assert.equal(r.rung, 1);
});

test('recall recommends rung 3 when Mind cannot ground', () => {
  const r = conductor.recommendRung(plan('recall', { triageConfidence: 0.8 }), { mindCanGround: false });
  assert.equal(r.rung, 3);
  assert.match(r.reason, /cannot ground/);
});

test('escalated plan recommends rung 2 (local reasoning) by default', () => {
  assert.equal(conductor.recommendRung(plan('ambiguous', { triageConfidence: 0.4, escalated: true })).rung, 2);
});

test('escalated + strong outcome history for a CLI recommends rung 3', () => {
  const r = conductor.recommendRung(
    plan('ambiguous', { triageConfidence: 0.4, escalated: true }),
    { bestCliFor: { cli: 'codex', validatedRate: 0.8, n: 12 } },
  );
  assert.equal(r.rung, 3);
  assert.match(r.reason, /codex/);
});

test('confident non-tool triage stays at rung 1', () => {
  assert.equal(conductor.recommendRung(plan('ambiguous', { triageConfidence: 0.9 })).rung, 1);
});

test('low-confidence non-tool triage uses rung 2 before frontier', () => {
  assert.equal(conductor.recommendRung(plan('ambiguous', { triageConfidence: 0.3 })).rung, 2);
});

test('every recommendation is advisory and carries the rung info', () => {
  const r = conductor.recommendRung(plan('greeting', { triageConfidence: 0.95 }));
  assert.equal(r.advisory, true);
  assert.ok(r.rungInfo && r.rungInfo.tier);
});

test('LADDER has three rungs, rung 3 is the only frontier tier', () => {
  assert.deepEqual(Object.keys(conductor.LADDER), ['1', '2', '3']);
  assert.equal(conductor.LADDER[1].tier, 'local');
  assert.equal(conductor.LADDER[2].tier, 'local');
  assert.equal(conductor.LADDER[3].tier, 'frontier');
});
