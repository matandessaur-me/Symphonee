'use strict';
// Unit tests for the Origin/Host firewall extracted from server.js.
// SECURITY-RELEVANT: this gate is the only thing standing between a malicious web
// page (CSRF / DNS-rebinding) and the unauthenticated high-privilege local API.
const test = require('node:test');
const assert = require('node:assert');
const { createFirewall } = require('./request-firewall');

const fw = createFirewall('127.0.0.1', 3800);
const reqWith = (headers) => ({ headers });

test('no Origin = trusted local caller (CLI/curl) -> allowed', () => {
  assert.equal(fw.isRequestAllowed(reqWith({ host: '127.0.0.1:3800' })), true);
  assert.equal(fw.isRequestAllowed(reqWith({})), true); // no host either
});

test('same-origin renderer is allowed (all loopback spellings)', () => {
  for (const origin of ['http://127.0.0.1:3800', 'http://localhost:3800', 'HTTP://127.0.0.1:3800']) {
    assert.equal(fw.isRequestAllowed(reqWith({ host: '127.0.0.1:3800', origin })), true, origin);
  }
});

test('foreign Origin (CSRF) is rejected even on a loopback Host', () => {
  assert.equal(fw.isRequestAllowed(reqWith({ host: '127.0.0.1:3800', origin: 'https://evil.example' })), false);
  assert.equal(fw.isRequestAllowed(reqWith({ host: '127.0.0.1:3800', origin: 'null' })), false); // opaque origin
});

test('non-loopback Host (DNS-rebinding) is rejected', () => {
  assert.equal(fw.isRequestAllowed(reqWith({ host: 'attacker.com' })), false);
  assert.equal(fw.isRequestAllowed(reqWith({ host: 'attacker.com:3800', origin: 'http://127.0.0.1:3800' })), false);
});

test('predicate helpers behave', () => {
  assert.equal(fw.hostIsLoopback('localhost:3800'), true);
  assert.equal(fw.hostIsLoopback('[::1]'), true);
  assert.equal(fw.hostIsLoopback('1.2.3.4:3800'), false);
  assert.equal(fw.originAllowed(''), true);            // absent
  assert.equal(fw.originAllowed('http://localhost:3800'), true);
  assert.equal(fw.originAllowed('http://localhost:9999'), false); // wrong port
});
