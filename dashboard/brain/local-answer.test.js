'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const la = require('./local-answer');

test('_keyTerms strips question stopwords so the topic drives retrieval', () => {
  assert.equal(la._keyTerms('what do you know about aurora3'), 'aurora3');
  assert.equal(la._keyTerms('what did we decide about the embedding fix'), 'decide embedding fix');
  // all-stopword question falls back to the original
  assert.ok(la._keyTerms('what is it').length > 0);
});

test('_humanize strips robotic preambles and capitalizes', () => {
  assert.equal(la._humanize('Based on your notes, Aurora3 is a project.'), 'Aurora3 is a project.');
  assert.equal(la._humanize("The user's notes indicate that it failed."), 'It failed.');
  assert.equal(la._humanize('According to your notes: it works.'), 'It works.');
  assert.equal(la._humanize('Aurora3 is fine.'), 'Aurora3 is fine.'); // unchanged when clean
});

test('nodeContent prefers inline body, then file-backed, then label', () => {
  assert.equal(la.nodeContent({ kind: 'memory', body: 'a fact' }), 'a fact');
  assert.equal(la.nodeContent({ kind: 'qa', answer: 'the answer' }), 'the answer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-la-'));
  const file = path.join(dir, 'note.md');
  fs.writeFileSync(file, '# Note\nfull note body here', 'utf8');
  try {
    assert.match(la.nodeContent({ kind: 'note', label: 'note', source: { file } }), /full note body/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(la.nodeContent({ kind: 'concept', label: 'just a label' }), 'just a label');
});

test('retrieveSources (BM25 leg, offline) finds content-bearing knowledge and drops stubs', async () => {
  const graph = {
    nodes: [
      { id: 'note_aurora', kind: 'note', label: 'Aurora3 - Production Readiness Plan', body: 'Aurora3 production readiness: secure integrations, migrate CMS to Builder.io, harden booking flow.' },
      { id: 'concept_stub', kind: 'concept', label: 'Aurora3 thing' }, // tiny stub, no body
      { id: 'drawer_noise', kind: 'drawer', label: 'aurora3 aurora3 aurora3', body: 'raw cli log mentioning aurora3 many times '.repeat(5) },
    ],
    edges: [], gods: [],
  };
  // monkeypatch store.loadGraph to return our synthetic graph
  const store = require('../mind/store');
  const orig = store.loadGraph;
  store.loadGraph = () => graph;
  try {
    const r = await la.retrieveSources('/tmp', '_global', 'what do you know about aurora3', 6);
    const ids = r.sources.map(s => s.id);
    assert.ok(ids.includes('note_aurora'), 'the note with real content is retrieved');
    assert.ok(!ids.includes('concept_stub'), 'label-only stub is dropped');
    assert.ok(!ids.includes('drawer_noise'), 'raw drawer is excluded (not a knowledge kind)');
  } finally {
    store.loadGraph = orig;
  }
});

test('KNOWLEDGE_KINDS excludes drawer, includes note/doc/memory', () => {
  assert.ok(la.KNOWLEDGE_KINDS.has('note'));
  assert.ok(la.KNOWLEDGE_KINDS.has('memory'));
  assert.ok(!la.KNOWLEDGE_KINDS.has('drawer'));
});

// ── the context bus: successes, fresh memory, edited notes ──────────────────

function _withTasksFile(tasks, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-ctx-'));
  const dir = path.join(root, '.ai-workspace', 'orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks), 'utf8');
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('_recentSuccesses picks fresh completed tasks with their result, newest first', () => {
  const now = Date.now();
  _withTasksFile([
    { id: 'old', state: 'completed', cli: 'codex', result: 'ancient', completedAt: now - 60 * 60 * 1000 },
    { id: 'new1', state: 'completed', cli: 'gemini', result: 'fresh result', prompt: 'do a thing', completedAt: now - 60 * 1000 },
    { id: 'fail', state: 'failed', cli: 'claude', error: 'boom', completedAt: now - 30 * 1000 },
    { id: 'new2', state: 'completed', cli: 'copilot', result: 'fresher', completedAt: now - 10 * 1000 },
  ], (root) => {
    const s = la._recentSuccesses(root);
    assert.deepEqual(s.map(x => x.id), ['new2', 'new1'], 'fresh successes only, newest first; failures and stale excluded');
    assert.equal(s[1].result, 'fresh result');
    assert.equal(s[1].prompt, 'do a thing');
  });
});

test('_recentSuccesses tolerates a missing tasks file', () => {
  assert.deepEqual(la._recentSuccesses(path.join(os.tmpdir(), 'nope-' + Date.now())), []);
});

test('_recentMemories surfaces only fresh memory cards from the graph', () => {
  const now = Date.now();
  const graph = { nodes: [
    { id: 'm_new', kind: 'memory', label: 'A fresh decision', kindOfMemory: 'decision', createdBy: 'codex', createdAt: new Date(now - 5 * 60000).toISOString() },
    { id: 'm_old', kind: 'memory', label: 'Ancient lore', createdAt: new Date(now - 5 * 60 * 60 * 1000).toISOString() },
    { id: 'n_new', kind: 'note', label: 'Not a memory', createdAt: new Date(now).toISOString() },
    { id: 'm_undated', kind: 'memory', label: 'No timestamp' },
  ] };
  const m = la._recentMemories(graph);
  assert.deepEqual(m.map(x => x.id), ['m_new']);
  assert.equal(m[0].title, 'A fresh decision');
  assert.equal(m[0].kindOfMemory, 'decision');
});

test('_recentNotes finds recently edited notes by mtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-notes-'));
  try {
    const dir = path.join(root, 'notes', '_global');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Fresh Thread.md'), 'body', 'utf8');
    const oldFile = path.join(dir, 'Stale.md');
    fs.writeFileSync(oldFile, 'body', 'utf8');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, old, old);
    const notes = la._recentNotes(root, '_global');
    assert.deepEqual(notes.map(n => n.name), ['Fresh Thread']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('_recentNotes tolerates a missing notes dir', () => {
  assert.deepEqual(la._recentNotes(path.join(os.tmpdir(), 'nope-' + Date.now()), '_global'), []);
});

// ── the ask surface: time hints, cross-AI recall, deep answer ────────────────

test('_timeHintFromQuestion pulls a window out of the question', () => {
  assert.equal(la._timeHintFromQuestion('what did I do the last three weeks for the website project'), '3 weeks ago');
  assert.equal(la._timeHintFromQuestion('what happened in the past 2 days'), '2 days ago');
  assert.equal(la._timeHintFromQuestion('show me what changed 5 days ago'), '5 days ago');
  assert.equal(la._timeHintFromQuestion('what did we ship yesterday'), 'yesterday');
  assert.equal(la._timeHintFromQuestion('did I change my env recently'), '2 weeks ago');
  assert.equal(la._timeHintFromQuestion('what do you know about the parser'), null, 'no time words, no window');
  assert.equal(la._timeHintFromQuestion('what moved in the last week'), '1 week ago');
  assert.equal(la._timeHintFromQuestion('the last few months of work'), '3 months ago');
});

test('_recallLeg groups drawer turns by which AI was driving', () => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const graph = { nodes: [
    { id: 'd1', kind: 'drawer', label: 'turn', body: 'claude refactored the env loader for the website project', createdBy: 'claude', createdAt: iso(2 * 24 * 3600 * 1000) },
    { id: 'd2', kind: 'drawer', label: 'turn', body: 'codex fixed env parsing in the website project config', createdBy: 'codex', createdAt: iso(3 * 24 * 3600 * 1000) },
    { id: 'm1', kind: 'memory', label: 'env decision', body: 'we decided to keep env files per environment for the website project', createdAt: iso(24 * 3600 * 1000) },
    { id: 'old', kind: 'drawer', label: 'turn', body: 'ancient env work on the website', createdBy: 'claude', createdAt: iso(90 * 24 * 3600 * 1000) },
  ], edges: [] };
  const leg = la._recallLeg(graph, 'did I change my env for the website recently', { since: '2 weeks ago' });
  assert.ok(leg.byCli.claude && leg.byCli.claude.length === 1, 'claude turns grouped');
  assert.ok(leg.byCli.codex && leg.byCli.codex.length === 1, 'codex turns grouped');
  assert.ok(!JSON.stringify(leg.byCli).includes('ancient'), 'outside the window is excluded');
  assert.ok(leg.cards.some(c => c.id === 'm1'), 'memory cards ride along');
});

test('deepAnswer reports ungrounded when there is genuinely nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-deep-'));
  const store = require('../mind/store');
  const orig = store.loadGraph;
  store.loadGraph = () => ({ nodes: [], edges: [] });
  try {
    const events = [];
    const r = await la.deepAnswer({ repoRoot: root, question: 'what do you know about anything' }, (e) => events.push(e));
    assert.equal(r.grounded, false);
    assert.equal(r.reason, 'no-context');
    assert.ok(events.some(e => e.type === 'status'), 'status milestones emitted');
  } finally {
    store.loadGraph = orig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gatherContext carries the full bus: successes, mindNew, notesEdited', async () => {
  const now = Date.now();
  _withTasksFile([
    { id: 's1', state: 'completed', cli: 'gemini', result: 'r', completedAt: now - 1000 },
  ], (root) => {
    const store = require('../mind/store');
    const orig = store.loadGraph;
    store.loadGraph = () => ({ nodes: [
      { id: 'm1', kind: 'memory', label: 'fresh', createdAt: new Date(now).toISOString() },
    ] });
    return (async () => {
      try {
        const ctx = await la.gatherContext({ repoRoot: root, activeRepoPath: root });
        assert.equal(ctx.successes.length, 1);
        assert.equal(ctx.mindNew.length, 1);
        assert.ok(Array.isArray(ctx.notesEdited));
        assert.ok(Array.isArray(ctx.failures));
      } finally {
        store.loadGraph = orig;
      }
    })();
  });
});
