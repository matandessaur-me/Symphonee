'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const outcomes = require('./outcomes');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-outcomes-'));
}

test('recordOutcome rejects unknown outcome strings', () => {
  const root = tmpRoot();
  try {
    assert.equal(outcomes.recordOutcome(root, 'dec_1', 'bogus', {}), false);
    assert.equal(outcomes.recordOutcome(root, 'dec_1', '', {}), false);
    assert.equal(outcomes.recordOutcome(root, 'dec_1', null, {}), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recordOutcome accepts each valid outcome', () => {
  const root = tmpRoot();
  try {
    for (const o of outcomes.VALID_OUTCOMES) {
      assert.ok(outcomes.recordOutcome(root, 'dec_' + o, o, { intent: 'code-action', primaryCli: 'codex' }));
    }
    const all = outcomes.readOutcomes(root);
    assert.equal(all.length, outcomes.VALID_OUTCOMES.size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readOutcomes tolerates malformed lines', () => {
  const root = tmpRoot();
  try {
    const file = outcomes.outcomesFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken\n{"ts":1,"outcome":"validated","intent":"x"}\nnotjson\n', 'utf8');
    const all = outcomes.readOutcomes(root);
    assert.equal(all.length, 1);
    assert.equal(all[0].outcome, 'validated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getStats aggregates counts by intent and cli', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 8; i++) outcomes.recordOutcome(root, 'd' + i, 'validated', { intent: 'code-action', primaryCli: 'claude-code' });
    for (let i = 0; i < 2; i++) outcomes.recordOutcome(root, 'e' + i, 'corrected', { intent: 'code-action', primaryCli: 'claude-code' });
    for (let i = 0; i < 4; i++) outcomes.recordOutcome(root, 'f' + i, 'validated', { intent: 'recall', primaryCli: 'none' });
    const stats = outcomes.getStats(root);
    assert.equal(stats.total.n, 14);
    assert.equal(stats.total.validated, 12);
    assert.equal(stats.total.corrected, 2);
    // code-action bucket has 10 samples - rate gets computed
    assert.equal(stats.byIntent['code-action'].n, 10);
    assert.ok(Math.abs(stats.byIntent['code-action'].validatedRate - 0.8) < 0.01);
    // recall bucket has only 4 - too few, rate is null
    assert.equal(stats.byIntent['recall'].validatedRate, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getStats: byIntentCli nested view', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 11; i++) outcomes.recordOutcome(root, 'a' + i, 'validated', { intent: 'code-action', primaryCli: 'codex' });
    for (let i = 0; i < 11; i++) outcomes.recordOutcome(root, 'b' + i, 'corrected', { intent: 'code-action', primaryCli: 'grok' });
    const stats = outcomes.getStats(root);
    assert.equal(stats.byIntentCli['code-action']['codex'].validated, 11);
    assert.equal(stats.byIntentCli['code-action']['codex'].validatedRate, 1.0);
    assert.equal(stats.byIntentCli['code-action']['grok'].validated, 0);
    assert.equal(stats.byIntentCli['code-action']['grok'].validatedRate, 0.0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bestCliFor picks the highest validatedRate', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 11; i++) outcomes.recordOutcome(root, 'a' + i, 'validated', { intent: 'code-action', primaryCli: 'codex' });
    for (let i = 0; i < 11; i++) {
      outcomes.recordOutcome(root, 'b' + i, i < 6 ? 'validated' : 'corrected', { intent: 'code-action', primaryCli: 'claude-code' });
    }
    const stats = outcomes.getStats(root);
    const best = outcomes.bestCliFor(stats, 'code-action');
    assert.equal(best.cli, 'codex');
    assert.equal(best.validated, 11);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bestCliFor returns null when no bucket has enough samples', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 3; i++) outcomes.recordOutcome(root, 'a' + i, 'validated', { intent: 'code-action', primaryCli: 'codex' });
    const stats = outcomes.getStats(root);
    assert.equal(outcomes.bestCliFor(stats, 'code-action'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildPromptHint returns a sentence when there is signal', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 11; i++) outcomes.recordOutcome(root, 'a' + i, 'validated', { intent: 'code-action', primaryCli: 'codex' });
    const stats = outcomes.getStats(root);
    const hint = outcomes.buildPromptHint(stats, 'code-action');
    assert.match(hint, /codex/);
    assert.match(hint, /code-action/);
    assert.match(hint, /11\/11/);
    assert.match(hint, /100%/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildPromptHint returns empty string when not enough data', () => {
  const root = tmpRoot();
  try {
    for (let i = 0; i < 3; i++) outcomes.recordOutcome(root, 'a' + i, 'validated', { intent: 'code-action', primaryCli: 'codex' });
    const stats = outcomes.getStats(root);
    assert.equal(outcomes.buildPromptHint(stats, 'code-action'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pruneOld drops outcomes older than the threshold', () => {
  const root = tmpRoot();
  try {
    const file = outcomes.outcomesFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year ago
    const fresh = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
    fs.writeFileSync(file,
      JSON.stringify({ ts: old, outcome: 'validated', intent: 'x' }) + '\n' +
      JSON.stringify({ ts: fresh, outcome: 'validated', intent: 'x' }) + '\n',
      'utf8',
    );
    const r = outcomes.pruneOld(root, { olderThanDays: 180 });
    assert.equal(r.kept, 1);
    assert.equal(r.dropped, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VALID_OUTCOMES is the documented set', () => {
  assert.ok(outcomes.VALID_OUTCOMES.has('validated'));
  assert.ok(outcomes.VALID_OUTCOMES.has('contradicted'));
  assert.ok(outcomes.VALID_OUTCOMES.has('corrected'));
  assert.ok(outcomes.VALID_OUTCOMES.has('unused'));
  assert.equal(outcomes.VALID_OUTCOMES.size, 4);
});
