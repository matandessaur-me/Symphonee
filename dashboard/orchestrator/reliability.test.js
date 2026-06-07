'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CircuitBreaker, classifyError, retryDelay, scoreResult, MAX_RETRIES } = require('./reliability');

test('circuit opens after threshold transient failures, resets on success', () => {
  const cb = new CircuitBreaker();
  assert.equal(cb.isAvailable('grok'), true);
  cb.recordFailure('grok', new Error('timeout'));
  cb.recordFailure('grok', new Error('ECONNRESET'));
  const opened = cb.recordFailure('grok', new Error('503 error'));
  assert.equal(opened, true, 'circuit opened on 3rd failure');
  assert.equal(cb.isAvailable('grok'), false, 'unavailable while open');
  cb.recordSuccess('grok');
  assert.equal(cb.isAvailable('grok'), true, 'available after success reset');
});

test('permanent errors do not count toward the breaker', () => {
  const cb = new CircuitBreaker();
  for (let i = 0; i < 5; i++) cb.recordFailure('codex', new Error('API key invalid'));
  assert.equal(cb.isAvailable('codex'), true, 'auth errors are permanent, not transient');
});

test('classifyError flags transient/failover correctly', () => {
  assert.equal(classifyError(new Error('request timeout'), 'x').retryable, true);
  assert.equal(classifyError(new Error('out of credits'), 'x').failover, true);
  assert.equal(classifyError(new Error('401 unauthorized'), 'x').authError, true);
  assert.equal(classifyError(new Error('model not supported'), 'x').modelError, true);
});

test('scoreResult rewards substantial structured output', () => {
  assert.ok(scoreResult('x') < scoreResult('## Heading\n```js\ncode\n```\n'.repeat(20)));
  assert.equal(scoreResult(''), 0);
});

test('retryDelay grows with attempt and respects MAX_RETRIES const', () => {
  assert.ok(retryDelay(2) > retryDelay(0));
  assert.equal(MAX_RETRIES, 2);
});
