'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const voice = require('./voice');
const personas = require('./personas');

// ── personas ──────────────────────────────────────────────────────────────

test('resolveSurface defaults to coder/worker', () => {
  const s = personas.resolveSurface();
  assert.equal(s.userType, 'coder');
  assert.equal(s.role, 'worker');
  assert.equal(s.showIds, true);
});

test('non-technical persona hides ids/paths/jargon', () => {
  const s = personas.resolveSurface({ userType: 'non-technical' });
  assert.equal(s.showIds, false);
  assert.equal(s.showPaths, false);
  assert.equal(s.jargon, false);
});

test('unknown persona falls back to defaults without throwing', () => {
  const s = personas.resolveSurface({ userType: 'wizard', role: 'overlord' });
  assert.equal(s.userType, 'coder');
  assert.equal(s.role, 'worker');
});

test('controller role can dispatch; worker cannot', () => {
  assert.equal(personas.resolveSurface({ role: 'controller' }).canDispatch, true);
  assert.equal(personas.resolveSurface({ role: 'worker' }).canDispatch, false);
});

// ── templated recall ────────────────────────────────────────────────────────

const hit = (id, snippet, extra = {}) => ({ id, label: id, snippet, superseded: false, contradicted: false, ...extra });

test('templatedRecall fills a deterministic answer with ids for coders', () => {
  const surface = personas.resolveSurface({ userType: 'coder' });
  const r = voice.templatedRecall('what about X', [hit('m1', 'X is the rule'), hit('m2', 'Y supports it')], surface);
  assert.equal(r.grounded, true);
  assert.match(r.answer, /X is the rule \[m1\]/);
  assert.match(r.answer, /Also relevant/);
  assert.match(r.answer, /\[m2\]/);
  assert.deepEqual(r.citedNodeIds, ['m1', 'm2']);
});

test('templatedRecall hides ids for non-technical persona', () => {
  const surface = personas.resolveSurface({ userType: 'non-technical' });
  const r = voice.templatedRecall('what about X', [hit('m1', 'X is the rule'), hit('m2', 'Y')], surface);
  assert.doesNotMatch(r.answer, /\[m1\]/);
});

test('templatedRecall excludes superseded memory', () => {
  const r = voice.templatedRecall('q', [hit('m_old', 'old fact', { superseded: true }), hit('m_new', 'new fact')], { showIds: true, maxItems: 3 });
  assert.match(r.answer, /new fact/i);
  assert.doesNotMatch(r.answer, /old fact/i);
  assert.deepEqual(r.citedNodeIds, ['m_new']);
});

test('templatedRecall flags uncertainty when memory conflicts', () => {
  const r = voice.templatedRecall('q', [hit('m1', 'always cache', { contradicted: true }), hit('m2', 'never cache', { contradicted: true })], { showIds: false });
  assert.equal(r.uncertain, true);
  assert.match(r.answer, /uncertain/i);
});

test('templatedRecall reports not-grounded when all memory is superseded', () => {
  const r = voice.templatedRecall('q', [hit('m1', 'x', { superseded: true })], {});
  assert.equal(r.grounded, false);
  assert.equal(r.answer, null);
});

test('summary verbosity omits the "Also relevant" list', () => {
  const r = voice.templatedRecall('q', [hit('m1', 'top'), hit('m2', 'more')], { verbosity: 'summary', showIds: false, maxItems: 3 });
  assert.doesNotMatch(r.answer, /Also relevant/);
});

// ── front door ──────────────────────────────────────────────────────────────

test('frontDoor answers locally with a template at rung 1 recall', () => {
  const r = voice.frontDoor({
    recommendation: { rung: 1, intent: 'recall' },
    recall: { hits: [hit('m1', 'the answer')] },
    question: 'q',
    surface: personas.resolveSurface(),
  });
  assert.equal(r.source, 'templated');
  assert.match(r.answer, /the answer/i);
});

test('frontDoor escalates to the frontier voice for non-recall / higher rungs', () => {
  const r = voice.frontDoor({ recommendation: { rung: 3, intent: 'code-action', reason: 'needs tools' }, recall: null, question: 'q', surface: {} });
  assert.equal(r.source, 'escalate');
  assert.equal(r.rung, 3);
});

test('frontDoor escalates when rung-1 recall could not ground', () => {
  const r = voice.frontDoor({
    recommendation: { rung: 1, intent: 'recall' },
    recall: { hits: [] },
    question: 'q',
    surface: {},
  });
  assert.equal(r.source, 'escalate');
});
