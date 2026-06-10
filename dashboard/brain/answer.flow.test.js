'use strict';

/**
 * Behavior snapshot of the full answer() decision flow.
 *
 * The sibling answer.test.js covers the pure routing constants + message
 * builders but deliberately SKIPS the end-to-end flow because it needs Ollama.
 * This file closes that gap by mocking the two external seams - the local LLM
 * and the Mind recall - so the plan -> mind -> synth -> escalate decision
 * matrix is pinned deterministically.
 *
 * This is the Stage-1 safety net (note: symphonee-2.0-development-plan /
 * mind-extraction-scope): brain/answer is about to stop reading the graph
 * in-process and become a CLIENT of Mind. These assertions lock the OUTCOMES
 * (source / citations / escalation) so the refactor can be proven
 * behavior-preserving. The injection point (recall seam) is the only thing the
 * refactor changes; the assertions below must stay identical across it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const llm = require('../lib/llm');
const store = require('../mind/store');
const recallMod = require('../mind/recall');
const answer = require('./answer');

const FIXTURE_GRAPH = {
  nodes: [
    { id: 'n1', kind: 'memory', label: 'X is a constraint', score: 0 },
    { id: 'n2', kind: 'conversation', label: 'we chose Y', score: 0 },
  ],
  edges: [],
  gods: [],
};

// Mutable per-test responses the mocks read from.
let NEXT_TRIAGE = null;
let NEXT_SYNTH = null;
let NEXT_LOCAL = null;
let NEXT_HITS = null;

const _orig = {};
test.beforeEach(() => {
  _orig.chatOllama = llm.chatOllama;
  _orig.loadGraph = store.loadGraph;
  _orig.recall = recallMod.recall;

  llm.chatOllama = async (messages) => {
    const sys = (messages && messages[0] && messages[0].content) || '';
    if (/classify the user input/i.test(sys)) return { model: 'qwen-mock', json: NEXT_TRIAGE || {} };
    if (/OWN memory/i.test(sys)) return { model: 'gemma-mock', json: NEXT_SYNTH || {} };
    if (/answering a simple question/i.test(sys)) return { model: 'gemma-mock', json: NEXT_LOCAL || {} };
    return { model: 'mock', json: {} };
  };
  store.loadGraph = () => FIXTURE_GRAPH;
  recallMod.recall = () => ({ hits: NEXT_HITS || [] });
});
test.afterEach(() => {
  llm.chatOllama = _orig.chatOllama;
  store.loadGraph = _orig.loadGraph;
  recallMod.recall = _orig.recall;
  NEXT_TRIAGE = NEXT_SYNTH = NEXT_LOCAL = NEXT_HITS = null;
});

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sym-answer-')); }
function ctx() { return { repoRoot: tmpRoot(), space: 'test', intent: { summary: 'testing' }, ui: {} }; }

test('greeting -> no-op, no LLM answer', async () => {
  NEXT_TRIAGE = { intent: 'greeting', primary_cli: 'none', confidence: 0.95 };
  const r = await answer.answer('hey there', ctx());
  assert.equal(r.source, 'no-op');
  assert.equal(r.reason, 'greeting');
});

test('code-action -> escalate (never faked locally)', async () => {
  NEXT_TRIAGE = { intent: 'code-action', primary_cli: 'claude-code', confidence: 0.9 };
  const r = await answer.answer('add a null check to parseConfig', ctx());
  assert.equal(r.source, 'escalate');
  assert.equal(r.decision.intent, 'code-action');
});

test('recall with strong Mind hits -> source mind, with citations', async () => {
  NEXT_TRIAGE = { intent: 'recall', primary_cli: 'none', confidence: 0.9 };
  NEXT_HITS = [
    { id: 'n1', kind: 'memory', score: 6.0, snippet: 'X is a constraint we hit' },
    { id: 'n2', kind: 'conversation', score: 4.0, snippet: 'we decided to use Y' },
  ];
  NEXT_SYNTH = { answer: 'You decided to use Y because X was a constraint.', cited: ['n1', 'n2'], confidence: 0.8 };
  const r = await answer.answer('what did we decide about X', ctx());
  assert.equal(r.source, 'mind');
  assert.deepEqual(r.citedNodeIds, ['n1', 'n2']);
  assert.match(r.answer, /use Y/);
});

test('recall with only weak Mind hits -> escalate (no local hallucination)', async () => {
  NEXT_TRIAGE = { intent: 'recall', primary_cli: 'none', confidence: 0.9 };
  // top hit below MIN_MIND_SCORE (3.5) and strong count below MIN_GROUND_HITS
  NEXT_HITS = [{ id: 'n9', kind: 'drawer', score: 1.0, snippet: 'unrelated chatter' }];
  const r = await answer.answer('what did we decide about Z', ctx());
  assert.equal(r.source, 'escalate');
});

test('recall where synthesis returns null -> escalate', async () => {
  NEXT_TRIAGE = { intent: 'recall', primary_cli: 'none', confidence: 0.9 };
  NEXT_HITS = [
    { id: 'n1', kind: 'memory', score: 6.0, snippet: 'X is a constraint' },
    { id: 'n2', kind: 'conversation', score: 4.0, snippet: 'we chose Y' },
  ];
  NEXT_SYNTH = { answer: null, reason: 'off-topic' };
  const r = await answer.answer('what did we decide about X', ctx());
  assert.equal(r.source, 'escalate');
});

test('ambiguous -> local answer when gemma can handle it', async () => {
  NEXT_TRIAGE = { intent: 'ambiguous', primary_cli: 'none', confidence: 0.9 };
  NEXT_LOCAL = { answer: '2 + 2 is 4.', confidence: 0.6 };
  const r = await answer.answer('what is 2+2', ctx());
  assert.equal(r.source, 'local');
  assert.match(r.answer, /4/);
});

test('ambiguous where local declines -> escalate', async () => {
  NEXT_TRIAGE = { intent: 'ambiguous', primary_cli: 'none', confidence: 0.9 };
  NEXT_LOCAL = { answer: null, reason: 'needs tools' };
  const r = await answer.answer('inspect the build output', ctx());
  assert.equal(r.source, 'escalate');
});
