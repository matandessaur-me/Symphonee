'use strict';
// The ambient observer: deterministic digests of genuinely NEW activity.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const obs = require('./observer');

const NOW = Date.parse('2026-06-11T14:00:00Z');
const CTX = {
  activeRepo: 'demo',
  git: ['abc123 feat: ship the loader (2 hours ago)', 'def456 fix: tests (1 day ago)'],
  successes: [{ id: 't1', cli: 'gemini', prompt: 'summarize the release' }],
  failures: [],
  notesEdited: [{ name: 'Launch Plan', editedAt: NOW - 60000 }],
};

test('composeDigest distills new commits, tasks, and notes into one digest', () => {
  const d = obs.composeDigest(CTX, { lastAt: 0, headLine: null, taskIds: [], noteStamps: {} }, NOW);
  assert.ok(d, 'enough events -> digest');
  assert.match(d.title, /^Activity digest - 2026-06-11/);
  assert.match(d.body, /Repo: demo/);
  assert.match(d.body, /abc123 feat: ship the loader/);
  assert.match(d.body, /gemini completed: summarize the release/);
  assert.match(d.body, /Notes edited: Launch Plan/);
  assert.equal(d.state.headLine, CTX.git[0]);
  assert.deepEqual(d.state.taskIds, ['t1']);
});

test('composeDigest only reports commits ABOVE the previously digested head', () => {
  const prev = { lastAt: 0, headLine: 'def456 fix: tests (1 day ago)', taskIds: [], noteStamps: {} };
  const d = obs.composeDigest(CTX, prev, NOW);
  assert.ok(d);
  assert.ok(d.body.includes('abc123'), 'new commit included');
  assert.ok(!d.body.includes('def456'), 'already-digested commit excluded');
});

test('composeDigest stays silent on too little news or inside the gap', () => {
  // same head, same task, same note stamp -> nothing new
  const prev = { lastAt: 0, headLine: CTX.git[0], taskIds: ['t1'], noteStamps: { 'Launch Plan': NOW - 60000 } };
  assert.equal(obs.composeDigest(CTX, prev, NOW), null);
  // plenty new but the last digest was 5 minutes ago -> respect the gap
  const recent = { lastAt: NOW - 5 * 60 * 1000, headLine: null, taskIds: [], noteStamps: {} };
  assert.equal(obs.composeDigest(CTX, recent, NOW), null);
  // a single event is not a story
  const oneEvent = { ...CTX, successes: [], notesEdited: [] };
  assert.equal(obs.composeDigest(oneEvent, { lastAt: 0, headLine: 'def456 fix: tests (1 day ago)', taskIds: [], noteStamps: {} }, NOW), null);
});

test('observer state round-trips through .symphonee/observer.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-obs-'));
  try {
    assert.equal(obs.loadState(root).lastAt, 0);
    obs.saveState(root, { lastAt: NOW, headLine: 'abc', taskIds: ['t1'], noteStamps: { a: 1 } });
    const s = obs.loadState(root);
    assert.equal(s.lastAt, NOW);
    assert.equal(s.headLine, 'abc');
    assert.deepEqual(s.taskIds, ['t1']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start().tick gathers, saves, and persists state; never throws on a bad gather', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-obs2-'));
  try {
    const saved = [];
    const h = obs.start({
      repoRoot: root,
      gather: async () => CTX,
      save: (o) => { saved.push(o); return 'obs_test'; },
      intervalMs: 60 * 60 * 1000,
    });
    const id = await h.tick();
    assert.equal(id, 'obs_test');
    assert.equal(saved.length, 1);
    assert.match(saved[0].body, /abc123/);
    assert.ok(obs.loadState(root).lastAt > 0, 'state persisted after save');
    // second tick inside the gap: silent
    assert.equal(await h.tick(), null);
    h.stop();
    // a gather that throws must not propagate
    const h2 = obs.start({ repoRoot: root, gather: async () => { throw new Error('boom'); }, save: () => 'x', intervalMs: 60 * 60 * 1000 });
    assert.equal(await h2.tick(), null);
    h2.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
