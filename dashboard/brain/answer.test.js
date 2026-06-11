'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const answer = require('./answer');

test('LOCAL_INTENTS, MIND_FIRST_INTENTS, ALWAYS_ESCALATE are disjoint', () => {
  for (const i of answer.LOCAL_INTENTS) {
    assert.ok(!answer.MIND_FIRST_INTENTS.has(i), `${i} should not be in both LOCAL + MIND_FIRST`);
    assert.ok(!answer.ALWAYS_ESCALATE.has(i), `${i} should not be in both LOCAL + ALWAYS_ESCALATE`);
  }
  for (const i of answer.MIND_FIRST_INTENTS) {
    assert.ok(!answer.ALWAYS_ESCALATE.has(i), `${i} should not be in both MIND_FIRST + ALWAYS_ESCALATE`);
  }
});

test('greeting is in LOCAL_INTENTS so the brain can short-circuit it', () => {
  assert.ok(answer.LOCAL_INTENTS.has('greeting'));
});

test('code-action / plan / plugin-call / apps-action / browser-action all escalate', () => {
  for (const i of ['code-action', 'plan', 'plugin-call', 'apps-action', 'browser-action']) {
    assert.ok(answer.ALWAYS_ESCALATE.has(i), `${i} must escalate`);
  }
});

test('code-question and browse-files are mind-first (try Mind, may fall to escalate)', () => {
  assert.ok(answer.MIND_FIRST_INTENTS.has('code-question'));
  assert.ok(answer.MIND_FIRST_INTENTS.has('browse-files'));
});

test('recall is mind-first (never falls back to local hallucination)', () => {
  // recall asks about specific stored content. If Mind cannot ground it,
  // we escalate to a frontier CLI rather than letting gemma fabricate.
  assert.ok(answer.MIND_FIRST_INTENTS.has('recall'));
  assert.ok(!answer.LOCAL_INTENTS.has('recall'),
    'recall must NOT be in LOCAL_INTENTS - local fallback would hallucinate "no info"');
});

test('thresholds are sane', () => {
  assert.ok(answer.MIN_MIND_SCORE > 0);
  assert.ok(answer.MIN_GROUND_HITS >= 1);
});

test('_buildSynthesisMessages embeds question, snippets, and JSON output rule', () => {
  const msgs = answer._buildSynthesisMessages(
    'what did we figure out about X',
    [
      { id: 'n1', kind: 'memory', score: 5, snippet: 'X is a constraint we hit' },
      { id: 'n2', kind: 'conversation', score: 4, snippet: 'we decided to use Y instead' },
    ],
    { summary: 'user is debugging Y' },
  );
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /Symphonee/);
  assert.match(msgs[0].content, /strict JSON/);
  assert.match(msgs[1].content, /what did we figure out/);
  assert.match(msgs[1].content, /n1/);
  assert.match(msgs[1].content, /n2/);
});

test('_buildSynthesisMessages handles empty hits without crashing', () => {
  const msgs = answer._buildSynthesisMessages('q', [], null);
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].content, /\(none\)/);
});

test('_buildLocalMessages includes the no-tools instruction', () => {
  const msgs = answer._buildLocalMessages('what is 2+2', null);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /no preamble|terse|simple question|needs tools/i);
});

test('_buildLocalMessages includes intent context when supplied', () => {
  const msgs = answer._buildLocalMessages('q', { summary: 'fixing Aurora hero' });
  assert.match(msgs[0].content, /fixing Aurora hero/);
});

test('answer returns no-op for empty input', async () => {
  const r = await answer.answer('', {});
  assert.equal(r.source, 'no-op');
  assert.equal(r.error, 'input required');
});

test('answer returns no-op for non-string input', async () => {
  const r = await answer.answer(null, {});
  assert.equal(r.source, 'no-op');
});

// Note: tests that actually invoke planRoute / llm are intentionally
// skipped here - they require Ollama running with both models. The
// integration is exercised via the live server. These unit tests focus
// on the deterministic routing logic + message builders.
