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

// ── provenance: every rule says WHY it is speaking ───────────────────────────

test('every firing rule carries a because clause (provenance)', () => {
  const ctx = {
    idle: true,
    uncommitted: { count: 9, files: ['a.js'] },
    checkpoints: ['c1', 'c2'], git: ['1', '2', '3', '4'], conversation: [],
    failures: [{ id: 'f1', cli: 'codex', state: 'failed', classification: {} }],
    successes: [{ id: 's1', cli: 'gemini', result: 'did the thing', prompt: 'do the thing', completedAt: Date.now() }],
    mindNew: [{ id: 'm1', title: 'A durable fact', kindOfMemory: 'decision', createdBy: 'claude' }],
    notesEdited: [{ name: 'My Plan', editedAt: Date.now() - 60000 }],
  };
  const out = rules.runRules(ctx);
  assert.ok(out.length >= 6, 'all families fire on a rich context');
  for (const c of out) {
    assert.ok(typeof c.because === 'string' && c.because.length > 8, `${c.type} has a because`);
    assert.ok(!/^because/i.test(c.because), `${c.type} because reads as a clause (the UI prefixes "because")`);
  }
});

test('standing rules carry fingerprints; instance rules are once', () => {
  const standing = rules.uncommittedChanges({ uncommitted: { count: 9, files: [] }, activeRepo: 'r' });
  assert.ok(standing.fingerprint, 'commit-reminder stamps its state');
  assert.ok(!standing.once);
  const inst = rules.taskSuccess({ successes: [{ id: 's1', cli: 'gemini', completedAt: Date.now() }] });
  assert.equal(inst.once, true, 'a specific task speaks once');
  assert.equal(inst.type, 'task-success:s1');
});

test('the commit-reminder fingerprint buckets the count (11 -> 13 is the same state)', () => {
  const at11 = rules.uncommittedChanges({ uncommitted: { count: 11, files: [] }, activeRepo: 'r' });
  const at13 = rules.uncommittedChanges({ uncommitted: { count: 13, files: [] }, activeRepo: 'r' });
  const at16 = rules.uncommittedChanges({ uncommitted: { count: 16, files: [] }, activeRepo: 'r' });
  assert.equal(at11.fingerprint, at13.fingerprint);
  assert.notEqual(at11.fingerprint, at16.fingerprint);
});

// ── taskSuccess: the work landed - offer the gist and the next thread ───────

test('taskSuccess stays silent with no recent completions', () => {
  assert.equal(rules.taskSuccess({}), null);
  assert.equal(rules.taskSuccess({ successes: [] }), null);
});

test('taskSuccess offers the gist and a drafted next step', () => {
  const c = rules.taskSuccess({ successes: [{
    id: 'ok1', cli: 'codex', result: 'refactored module', prompt: 'refactor the parser', completedAt: Date.now() - 120000,
  }] });
  assert.equal(c.type, 'task-success:ok1');
  assert.equal(c.value, 0.88, 'below failure (0.9), above idle (0.85)');
  assert.match(c.title, /codex/);
  assert.match(c.detail, /refactor the parser/);
  assert.match(c.action.prompt, /next prompt/i, 'the action drafts the continuation');
  assert.equal(c.actionLabel, 'Next step');
  assert.match(c.because, /finished/);
});

// ── mindDelta: the shared brain just learned something ──────────────────────

test('mindDelta speaks once about a fresh memory card', () => {
  assert.equal(rules.mindDelta({}), null);
  assert.equal(rules.mindDelta({ mindNew: [] }), null);
  const c = rules.mindDelta({ mindNew: [{ id: 'mem1', title: 'Prefer rules over models', kindOfMemory: 'preference', createdBy: 'codex' }] });
  assert.equal(c.type, 'mind-delta:mem1');
  assert.equal(c.once, true);
  assert.match(c.title, /Prefer rules over models/);
  assert.match(c.because, /preference card from codex/);
});

// ── noteRevisit: pick the thread back up (idle only) ─────────────────────────

test('noteRevisit fires only when idle and a note was recently edited', () => {
  const note = { name: 'Launch Plan', editedAt: Date.now() - 5 * 60000 };
  assert.equal(rules.noteRevisit({ idle: false, notesEdited: [note] }), null);
  assert.equal(rules.noteRevisit({ idle: true, notesEdited: [] }), null);
  const c = rules.noteRevisit({ idle: true, notesEdited: [note] });
  assert.match(c.title, /Launch Plan/);
  assert.equal(c.fingerprint, 'Launch Plan');
  assert.ok(c.value < 0.85, 'unsaved work outranks a note thread');
});

// ── phrase rotation: the whisper never sounds canned ─────────────────────────

test('phrase pools rotate deterministically with shownCounts', () => {
  const ctx0 = { idle: true, uncommitted: { count: 0 }, git: [], checkpoints: [], conversation: [] };
  const first = rules.idleNudge({ ...ctx0, shownCounts: {} }).title;
  const second = rules.idleNudge({ ...ctx0, shownCounts: { inactivity: 1 } }).title;
  const third = rules.idleNudge({ ...ctx0, shownCounts: { inactivity: 2 } }).title;
  const wrapped = rules.idleNudge({ ...ctx0, shownCounts: { inactivity: 3 } }).title;
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.equal(wrapped, first, 'rotation wraps around the pool');
});

test('a fresh success outranks idle but loses to a fresh failure', () => {
  const ctx = {
    idle: true, uncommitted: { count: 0 }, git: [], checkpoints: [], conversation: [],
    failures: [{ id: 'f', cli: 'claude', state: 'failed', classification: {} }],
    successes: [{ id: 's', cli: 'gemini', completedAt: Date.now() }],
  };
  const out = rules.runRules(ctx).slice().sort((a, b) => b.value - a.value);
  assert.match(out[0].type, /^task-failure:/);
  assert.match(out[1].type, /^task-success:/);
});
