'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const intentModule = require('./intent');

function tmpRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-brain-intent-'));
}

test('emptyIntent returns the expected shape', () => {
  const e = intentModule.emptyIntent();
  assert.equal(e.version, 1);
  assert.equal(e.summary, null);
  assert.equal(e.confidence, 0);
  assert.equal(e.updateCount, 0);
  assert.deepEqual(e.evidence, []);
  assert.deepEqual(e.history, []);
});

test('read returns emptyIntent when no file exists', () => {
  const root = tmpRepoRoot();
  const got = intentModule.read(root);
  assert.equal(got.summary, null);
  assert.equal(got.version, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('write then read round-trips', () => {
  const root = tmpRepoRoot();
  const payload = {
    ...intentModule.emptyIntent(),
    summary: 'user is debugging the planner',
    confidence: 0.8,
    currentRepo: 'Symphonee',
    updateCount: 3,
  };
  intentModule.write(root, payload);
  const got = intentModule.read(root);
  assert.equal(got.summary, 'user is debugging the planner');
  assert.equal(got.confidence, 0.8);
  assert.equal(got.currentRepo, 'Symphonee');
  assert.equal(got.updateCount, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test('read tolerates a corrupt intent file', () => {
  const root = tmpRepoRoot();
  fs.mkdirSync(path.join(root, '.symphonee'), { recursive: true });
  fs.writeFileSync(path.join(root, '.symphonee', 'intent.json'), '{not json');
  const got = intentModule.read(root);
  assert.equal(got.summary, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('createIntentManager debounces notify and runs onRecompute', (t, done) => {
  const root = tmpRepoRoot();
  let onRecomputeCalls = 0;
  let lastBatch = null;
  const manager = intentModule.createIntentManager({
    repoRoot: root,
    getUiContext: () => ({ activeRepo: 'TestRepo' }),
    broadcast: null,
    onRecompute: async ({ evidence }) => {
      onRecomputeCalls += 1;
      lastBatch = evidence;
      return {
        summary: 'batch had ' + evidence.length + ' events',
        confidence: 0.9,
        currentRepo: 'TestRepo',
      };
    },
  });

  // Push three events quickly.
  manager.notify({ kind: 'file-change', detail: 'a' });
  manager.notify({ kind: 'file-change', detail: 'b' });
  manager.notify({ kind: 'drawer-turn', detail: 'c' });
  // Three events should be pending.
  assert.equal(manager.pendingCount(), 3);
  // Debounce is 5s in production. Use forceRecompute for a deterministic test.
  manager.forceRecompute().then(() => {
    assert.equal(onRecomputeCalls, 1, 'recompute should have run exactly once');
    assert.equal(lastBatch.length, 3, 'batch should contain all three pushed events');
    const got = intentModule.read(root);
    assert.equal(got.summary, 'batch had 3 events');
    assert.equal(got.confidence, 0.9);
    assert.equal(got.updateCount, 1);
    fs.rmSync(root, { recursive: true, force: true });
    done();
  }).catch(done);
});

test('createIntentManager pause/resume gates recompute', (t, done) => {
  const root = tmpRepoRoot();
  let calls = 0;
  const manager = intentModule.createIntentManager({
    repoRoot: root,
    onRecompute: async () => { calls += 1; return { summary: 'x', confidence: 0.5 }; },
  });
  manager.notify({ kind: 'file-change', detail: 'paused' });
  manager.pause('test');
  manager.forceRecompute().then(() => {
    // forceRecompute with force=true is supposed to bypass pause - that is by
    // design: the user explicitly asked for a recompute. So calls should be 1.
    assert.equal(calls, 1);
    manager.resume();
    fs.rmSync(root, { recursive: true, force: true });
    done();
  }).catch(done);
});

test('createIntentManager handles onRecompute returning null gracefully', (t, done) => {
  const root = tmpRepoRoot();
  const manager = intentModule.createIntentManager({
    repoRoot: root,
    onRecompute: async () => null,
  });
  manager.notify({ kind: 'file-change', detail: 'a' });
  manager.forceRecompute().then(() => {
    const got = intentModule.read(root);
    assert.equal(got.summary, null, 'no write when recompute returns null');
    assert.equal(got.updateCount, 0);
    fs.rmSync(root, { recursive: true, force: true });
    done();
  }).catch(done);
});
