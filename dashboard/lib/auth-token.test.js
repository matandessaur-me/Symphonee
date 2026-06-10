'use strict';
// SECURITY-RELEVANT: this gate decides whether a mutating request to the local
// API is allowed. A regression here either breaks the app or reopens the hole.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuthToken, isMutationMethod, tokensMatch, injectHtml, htmlSnippet } = require('./auth-token');

const req = (method, token) => ({ method, headers: token === undefined ? {} : { 'x-symphonee-token': token } });

test('isMutationMethod flags POST/PUT/DELETE/PATCH only (case-insensitive)', () => {
  for (const m of ['POST', 'put', 'Delete', 'patch']) assert.equal(isMutationMethod(m), true, m);
  for (const m of ['GET', 'HEAD', 'OPTIONS', '', null, undefined]) assert.equal(isMutationMethod(m), false, String(m));
});

test('tokensMatch is exact and rejects mismatches/lengths/types', () => {
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('abc', 'ab'), false);   // length differs
  assert.equal(tokensMatch('', ''), false);        // empty never matches
  assert.equal(tokensMatch('abc', null), false);
});

test('GET/HEAD always allowed (reads stay firewall-only)', () => {
  const a = createAuthToken({ token: 'secret' });
  assert.equal(a.isAllowed(req('GET')), true);
  assert.equal(a.isAllowed(req('GET', 'wrong')), true);
  assert.equal(a.isAllowed(req('HEAD')), true);
});

test('mutations require the exact token', () => {
  const a = createAuthToken({ token: 'secret-value' });
  assert.equal(a.isAllowed(req('POST', 'secret-value')), true);
  assert.equal(a.isAllowed(req('POST', 'wrong')), false);
  assert.equal(a.isAllowed(req('POST')), false);          // no header
  assert.equal(a.isAllowed(req('DELETE', 'secret-value')), true);
  assert.equal(a.isAllowed(req('PUT')), false);
});

test('array-valued header takes the first value', () => {
  const a = createAuthToken({ token: 't' });
  assert.equal(a.isAllowed({ method: 'POST', headers: { 'x-symphonee-token': ['t', 'x'] } }), true);
});

test('persist writes a 0600 runtime file the MCP/scripts can read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-tok-'));
  const runtimePath = path.join(dir, 'config', 'runtime.json');
  const a = createAuthToken({ runtimePath, port: 3800, token: 'persisted-tok' });
  a.persist();
  const onDisk = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  assert.equal(onDisk.token, 'persisted-tok');
  assert.equal(onDisk.port, 3800);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(runtimePath).mode & 0o777, 0o600, 'owner-only perms');
  }
});

test('auto-generated tokens are unique 64-hex strings', () => {
  const a = createAuthToken({});
  const b = createAuthToken({});
  assert.match(a.value, /^[0-9a-f]{64}$/);
  assert.notEqual(a.value, b.value);
});

test('injectHtml places the snippet right after <head> and embeds the token', () => {
  const out = injectHtml('<html><head>\n<title>x</title></head><body></body></html>', 'TKN');
  assert.ok(out.indexOf('<head>') < out.indexOf('__SYMPHONEE_TOKEN__'), 'snippet is after <head>');
  assert.ok(out.includes('"TKN"'), 'token embedded as a JS string');
  assert.ok(out.indexOf('__SYMPHONEE_TOKEN__') < out.indexOf('<title>'), 'snippet before original head content');
});

test('injectHtml falls back to prepend when there is no <head>', () => {
  const out = injectHtml('<body>no head</body>', 'TKN');
  assert.ok(out.startsWith('<script>'), 'prepended');
});

test('htmlSnippet only attaches the header to mutating methods (smoke of the wrapped fetch)', () => {
  // Execute the generated snippet in a tiny fake DOM and assert behaviour.
  const calls = [];
  const sandbox = makeBrowserSandbox(calls);
  runSnippet(htmlSnippet('THE-TOKEN'), sandbox);
  // GET -> no token header
  sandbox.window.fetch('/api/x', { method: 'GET' });
  // POST -> token header added
  sandbox.window.fetch('/api/y', { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(calls[0].headers, undefined, 'GET untouched');
  assert.equal(calls[1].headers.get('x-symphonee-token'), 'THE-TOKEN', 'POST carries token');
  assert.equal(calls[1].headers.get('content-type'), 'application/json', 'existing headers preserved');
  assert.equal(sandbox.window.__SYMPHONEE_TOKEN__, 'THE-TOKEN');
});

// ── tiny browser sandbox for exercising the injected snippet ──────────────────
function makeBrowserSandbox(calls) {
  class FakeHeaders {
    constructor(init) { this._m = new Map(); if (init) for (const [k, v] of Object.entries(init)) this._m.set(k.toLowerCase(), v); }
    has(k) { return this._m.has(k.toLowerCase()); }
    set(k, v) { this._m.set(k.toLowerCase(), v); }
    get(k) { return this._m.get(k.toLowerCase()); }
  }
  const origFetch = function (i, n) { calls.push({ url: i, method: (n && n.method) || 'GET', headers: n && n.headers }); return Promise.resolve(); };
  class FakeXHR { open() {} send() {} setRequestHeader() {} }
  return {
    window: { fetch: origFetch },
    Headers: FakeHeaders,
    XMLHttpRequest: FakeXHR,
  };
}
function runSnippet(snippetHtml, sandbox) {
  const js = snippetHtml.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const fn = new Function('window', 'Headers', 'XMLHttpRequest', js);
  fn(sandbox.window, sandbox.Headers, sandbox.XMLHttpRequest);
}
