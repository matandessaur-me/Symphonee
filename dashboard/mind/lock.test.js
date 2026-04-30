'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const lock = require('./lock');

test('lock acquire then release roundtrip', () => {
  const r = lock.acquire('_unit_test', 'lock1');
  assert.ok(r.ok, 'acquire ok');
  assert.equal(r.holderPid, process.pid);
  const s = lock.status('_unit_test', 'lock1');
  assert.ok(s.locked, 'status reports locked');
  assert.equal(s.holderPid, process.pid);
  lock.release('_unit_test', 'lock1');
  const after = lock.status('_unit_test', 'lock1');
  assert.equal(after.locked, false);
});

test('lock acquire is idempotent in the same process', () => {
  const r1 = lock.acquire('_unit_test', 'lock2');
  assert.ok(r1.ok);
  const r2 = lock.acquire('_unit_test', 'lock2');
  assert.ok(r2.ok);
  assert.ok(r2.alreadyHeld);
  lock.release('_unit_test', 'lock2');
});

test('terminateHolder on self releases the lock cleanly', () => {
  lock.acquire('_unit_test', 'lock3');
  const r = lock.terminateHolder('_unit_test', 'lock3');
  assert.equal(r.terminated, true);
  assert.equal(r.reason, 'self-released');
  assert.equal(lock.status('_unit_test', 'lock3').locked, false);
});

test('lock status on absent file returns locked=false', () => {
  const s = lock.status('_unit_test', 'never-acquired');
  assert.equal(s.locked, false);
});
