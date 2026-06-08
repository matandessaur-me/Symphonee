'use strict';
// Unit tests for the learnings redaction layer extracted from learnings.js.
// SECURITY-RELEVANT: locks down what gets stripped before a learning is shared
// to the public registry. Previously only exercised through the live share path.
const test = require('node:test');
const assert = require('node:assert');
const s = require('./learnings-sanitize');

test('sanitize redacts emails, tokens, external URLs, paths, inline secrets', () => {
  assert.ok(!s.sanitize('reach me at jane.doe@example.com').includes('@example.com'));
  assert.ok(!s.sanitize('key ghp_ABC123def456 here').includes('ghp_ABC123def456'));
  assert.ok(!s.sanitize('see https://internal.corp.example/path').includes('internal.corp'));
  assert.ok(!s.sanitize('file at C:\\Users\\matan\\secret.txt').includes('matan'));
  assert.ok(!s.sanitize('lives in /home/matan/.ssh/id_rsa').includes('id_rsa'));
  assert.ok(!s.sanitize('password: hunter2').includes('hunter2'));
});

test('sanitize keeps the localhost API URL (not external)', () => {
  const out = s.sanitize('call http://127.0.0.1:3800/api/learnings to fetch');
  assert.ok(out.includes('127.0.0.1:3800/api/learnings'));
});

test('sanitize collapses runs of redacted markers', () => {
  const out = s.sanitize('a@b.com c@d.com e@f.com');
  assert.ok(!/(\[REDACTED\]\s*){2,}/.test(out)); // no 2+ consecutive markers
});

test('isSuspicious flags leftover redactions and company-specific mentions', () => {
  assert.equal(s.isSuspicious('still has [REDACTED] in it'), true);
  assert.equal(s.isSuspicious('this is about a client deliverable'), true);
  assert.equal(s.isSuspicious('proprietary and confidential notes'), true);
  // global-flag regexes must not go stateful across calls
  assert.equal(s.isSuspicious('mentions bathfitter brand'), true);
  assert.equal(s.isSuspicious('mentions bathfitter brand'), true); // same answer twice
});

test('isSuspicious passes clean, generic technical text', () => {
  assert.equal(s.isSuspicious('use forward slashes in bash paths on windows'), false);
  assert.equal(s.isSuspicious('the powershell curl alias hangs on -s'), false);
});
