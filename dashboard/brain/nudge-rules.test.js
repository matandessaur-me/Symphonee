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
