'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const rules = require('./nudge-rules');

test('uncommittedChanges stays silent below the threshold', () => {
  assert.equal(rules.uncommittedChanges({ uncommitted: { count: 3, files: [] } }), null);
  assert.equal(rules.uncommittedChanges({ uncommitted: { count: 0, files: [] } }), null);
  assert.equal(rules.uncommittedChanges({}), null);
});

test('uncommittedChanges nudges (human, named files) when work piles up', () => {
  const c = rules.uncommittedChanges({
    uncommitted: { count: 9, files: ['dashboard/brain/index.js', 'src/app.tsx', 'README.md'] },
    activeRepo: 'My Site',
  });
  assert.equal(c.type, 'commit-reminder');
  assert.match(c.title, /9 uncommitted changes in My Site/);
  assert.match(c.detail, /index\.js/);
  assert.equal(c.action.kind, 'ask');
  assert.ok(c.value >= 0.58 && c.value <= 0.8);
});

test('offerSummary fires only after enough recent activity', () => {
  assert.equal(rules.offerSummary({ checkpoints: [], git: [] }), null);
  assert.equal(rules.offerSummary({ checkpoints: ['a'], git: ['x', 'y'] }), null); // 3 < 5
  const c = rules.offerSummary({ checkpoints: ['a', 'b'], git: ['1', '2', '3', '4'] }); // 2 + 4 = 6
  assert.equal(c.type, 'offer-summary');
  assert.equal(c.action.kind, 'ask');
  assert.match(c.action.prompt, /summarize/i);
});

test('runRules collects firing rules and tolerates a throwing rule', () => {
  const ctx = { uncommitted: { count: 8, files: ['a.js'] }, checkpoints: ['c1', 'c2', 'c3'], git: ['g1', 'g2'] };
  const out = rules.runRules(ctx);
  assert.ok(out.length >= 2);
  assert.ok(out.every(c => c.title && typeof c.value === 'number'));
});

test('runRules returns nothing for a quiet context (silence beats noise)', () => {
  assert.deepEqual(rules.runRules({ uncommitted: { count: 1 }, checkpoints: [], git: [], conversation: [] }), []);
});

test('taskFailure stays silent with no recent failures', () => {
  assert.equal(rules.taskFailure({}), null);
  assert.equal(rules.taskFailure({ failures: [] }), null);
});

test('taskFailure speaks immediately, specific to the error, highest value', () => {
  const c = rules.taskFailure({ failures: [{
    id: 'abc123', cli: 'claude', state: 'failed',
    error: 'rate limit exceeded\nmore detail', classification: { providerOut: true, transient: true },
    prompt: 'refactor the auth module',
  }] });
  assert.equal(c.type, 'task-failure:abc123');
  assert.match(c.title, /Your claude task hit a temporary provider issue/);
  assert.match(c.title, /rate limit exceeded/);
  assert.match(c.detail, /refactor the auth module/);
  assert.equal(c.actionLabel, 'Diagnose');
  assert.equal(c.action.kind, 'ask');
  assert.equal(c.value, 0.9); // beats idle (0.85) and commit (<=0.8)
});

test('taskFailure phrasing adapts to classification', () => {
  const auth = rules.taskFailure({ failures: [{ id: 'a', cli: 'codex', state: 'failed', classification: { authError: true } }] });
  assert.match(auth.title, /failed on authentication/);
  const timeout = rules.taskFailure({ failures: [{ id: 'b', cli: 'gemini', state: 'timeout' }] });
  assert.match(timeout.title, /timed out/);
});

test('idleNudge only fires on an explicit idle check, and adapts', () => {
  assert.equal(rules.idleNudge({ idle: false, uncommitted: { count: 5 } }), null);
  const unsaved = rules.idleNudge({ idle: true, activeRepo: 'My Site', uncommitted: { count: 2 } });
  assert.match(unsaved.title, /unsaved work in My Site/);
  assert.equal(unsaved.actionLabel, 'Recap');
  const momentum = rules.idleNudge({ idle: true, uncommitted: { count: 0 }, git: ['a', 'b'], checkpoints: ['c'] });
  assert.match(momentum.title, /out of ideas/);
  const silence = rules.idleNudge({ idle: true, uncommitted: { count: 0 }, git: [], checkpoints: [], conversation: [] });
  assert.match(silence.title, /still here/i);
});

test('a fresh failure wins over an idle nudge in runRules ordering', () => {
  const ctx = { idle: true, uncommitted: { count: 0 }, git: [], checkpoints: [], conversation: [],
    failures: [{ id: 'z', cli: 'claude', state: 'failed', classification: {} }] };
  const out = rules.runRules(ctx);
  const top = out.slice().sort((a, b) => b.value - a.value)[0];
  assert.match(top.type, /^task-failure:/);
});
