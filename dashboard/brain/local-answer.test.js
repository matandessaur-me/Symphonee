'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const la = require('./local-answer');

test('_keyTerms strips question stopwords so the topic drives retrieval', () => {
  assert.equal(la._keyTerms('what do you know about dyob3'), 'dyob3');
  assert.equal(la._keyTerms('what did we decide about the embedding fix'), 'decide embedding fix');
  // all-stopword question falls back to the original
  assert.ok(la._keyTerms('what is it').length > 0);
});

test('_humanize strips robotic preambles and capitalizes', () => {
  assert.equal(la._humanize('Based on your notes, DYOB3 is a project.'), 'DYOB3 is a project.');
  assert.equal(la._humanize("The user's notes indicate that it failed."), 'It failed.');
  assert.equal(la._humanize('According to your notes: it works.'), 'It works.');
  assert.equal(la._humanize('DYOB3 is fine.'), 'DYOB3 is fine.'); // unchanged when clean
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
      { id: 'note_dyob', kind: 'note', label: 'DYOB3 - Production Readiness Plan', body: 'DYOB3 production readiness: secure integrations, migrate CMS to Builder.io, harden booking flow.' },
      { id: 'concept_stub', kind: 'concept', label: 'DYOB3 thing' }, // tiny stub, no body
      { id: 'drawer_noise', kind: 'drawer', label: 'dyob3 dyob3 dyob3', body: 'raw cli log mentioning dyob3 many times '.repeat(5) },
    ],
    edges: [], gods: [],
  };
  // monkeypatch store.loadGraph to return our synthetic graph
  const store = require('../mind/store');
  const orig = store.loadGraph;
  store.loadGraph = () => graph;
  try {
    const r = await la.retrieveSources('/tmp', '_global', 'what do you know about dyob3', 6);
    const ids = r.sources.map(s => s.id);
    assert.ok(ids.includes('note_dyob'), 'the note with real content is retrieved');
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
