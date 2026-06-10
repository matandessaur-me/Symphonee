'use strict';
const test = require('node:test');
const assert = require('node:assert');
const shared = require('./chat-http-shared');
const appsHttp = require('./apps/apps-chat-http');
const browserHttp = require('./browser/browser-chat-http');

test('isTransientError matches retryable failures only', () => {
  for (const m of ['429 Too Many Requests', 'SSL routines', 'BAD_RECORD_MAC',
    'read ECONNRESET', 'connect ECONNREFUSED', 'ETIMEDOUT', 'socket hang up', 'request timed out']) {
    assert.equal(shared.isTransientError(new Error(m)), true, m);
  }
  for (const m of ['400 Bad Request', '401 Unauthorized', 'invalid json', '']) {
    assert.equal(shared.isTransientError(new Error(m)), false, m);
  }
  assert.equal(shared.isTransientError({}), false, 'no message -> not transient');
});

test('isAbortError recognises abort messages', () => {
  assert.equal(shared.isAbortError(new Error('host request aborted')), true);
  assert.equal(shared.isAbortError(new Error('host stream aborted')), true);
  assert.equal(shared.isAbortError('aborted'), true);
  assert.equal(shared.isAbortError(new Error('429')), false);
  assert.equal(shared.isAbortError(null), false);
});

test('bindAbort: no signal -> no-op cleanup', () => {
  const cleanup = shared.bindAbort({ destroy() {} }, null, () => {});
  assert.equal(typeof cleanup, 'function');
  cleanup(); // must not throw
});

test('bindAbort: already-aborted signal destroys + rejects immediately', () => {
  let destroyed = false, rejected = false;
  const req = { destroy() { destroyed = true; } };
  shared.bindAbort(req, { aborted: true }, () => { rejected = true; }, 'x aborted');
  assert.ok(destroyed && rejected, 'destroy + reject fired for pre-aborted signal');
});

test('bindAbort: fires on later abort event, cleanup detaches listener', () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (_e, fn) => listeners.add(fn),
    removeEventListener: (_e, fn) => listeners.delete(fn),
  };
  let destroyed = false;
  const req = { destroy() { destroyed = true; } };
  const cleanup = shared.bindAbort(req, signal, () => {}, 'x aborted');
  assert.equal(listeners.size, 1, 'listener attached');
  [...listeners][0](); // simulate abort
  assert.ok(destroyed, 'destroy fired on abort');
  cleanup();
  assert.equal(listeners.size, 0, 'cleanup detached listener');
});

test('both agent transports re-export the SAME shared helpers (no drift)', () => {
  for (const k of ['bindAbort', 'isAbortError', 'isTransientError']) {
    assert.equal(appsHttp[k], shared[k], `apps ${k} is the shared one`);
    assert.equal(browserHttp[k], shared[k], `browser ${k} is the shared one`);
  }
  // The divergent transport functions stay distinct between the two agents.
  assert.notEqual(appsHttp.httpJson, browserHttp.httpJson, 'httpJson stays separate');
});
