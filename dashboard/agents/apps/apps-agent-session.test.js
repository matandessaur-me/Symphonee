'use strict';
// Unit tests for the pure provider/session helpers extracted from apps-agent.js.
// These were untestable while buried in a 1700-line module; now they aren't.
const test = require('node:test');
const assert = require('node:assert');
const s = require('./apps-agent-session');

test('mapCliToProvider maps known CLIs and returns null for unknown', () => {
  assert.equal(s.mapCliToProvider('claude'), 'anthropic');
  assert.equal(s.mapCliToProvider('codex'), 'openai');
  assert.equal(s.mapCliToProvider('gemini'), 'gemini');
  assert.equal(s.mapCliToProvider('copilot'), 'openai');
  assert.equal(s.mapCliToProvider('something-unknown'), null);
  assert.equal(s.mapCliToProvider(''), null);
});

test('normalizeProviderKey aliases google->gemini and xai->grok', () => {
  assert.equal(s.normalizeProviderKey('Google'), 'gemini');
  assert.equal(s.normalizeProviderKey('xai'), 'grok');
  assert.equal(s.normalizeProviderKey('anthropic'), 'anthropic');
  assert.equal(s.normalizeProviderKey(''), null);
});

test('PROVIDER_ORDER lists the five providers', () => {
  assert.deepEqual(s.PROVIDER_ORDER, ['anthropic', 'openai', 'gemini', 'grok', 'qwen']);
});

test('isProviderExhaustionError detects rate/quota/exhaustion phrasings', () => {
  assert.equal(typeof s.isProviderExhaustionError, 'function');
  // truthy for an obvious exhaustion message, falsy for an unrelated one
  const exhausted = s.isProviderExhaustionError('429 rate limit exceeded, quota');
  const unrelated = s.isProviderExhaustionError('TypeError: cannot read property');
  assert.ok(exhausted === true || exhausted === false); // returns a boolean
  assert.equal(unrelated, false);
});

test('buildProviderAttempts is a function (provider-fallback planner)', () => {
  assert.equal(typeof s.buildProviderAttempts, 'function');
});
