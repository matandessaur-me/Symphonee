'use strict';
// auth-token -- a per-boot bearer token that gates STATE-MUTATING requests
// (POST/PUT/DELETE/PATCH) to the local API. The request firewall already blocks
// cross-site and DNS-rebinding callers, but it trusts any local process that
// omits an Origin header (so CLIs keep working) -- which means another local
// process could drive privileged ACTIONS (git push with your PAT, plugin
// install = RCE into the server, agent spawn, file writes). This token closes
// that vector: the renderer, spawned CLIs, the PowerShell helpers, and the MCP
// bridge all present the token; a process that doesn't have it can't mutate.
//
// GET reads stay firewall-only by design: a local process running as you can
// already read your files/config off disk, so token-gating reads adds little.
//
// SECURITY-RELEVANT and split out so the allow/deny logic is unit-testable.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function isMutationMethod(method) {
  return MUTATING.has(String(method || '').toUpperCase());
}

// Constant-time equality so a timing side-channel can't reveal the token.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}

// The inline <script> injected into every served HTML document (top window AND
// plugin iframes). It records the token and wraps fetch + XHR so same-document
// mutating requests carry the header automatically -- no per-call-site edits,
// and plugin SDK fetches inherit it through the wrapped fetch.
function htmlSnippet(token) {
  const t = JSON.stringify(String(token));
  return '<script>(function(){var T=' + t + ';try{window.__SYMPHONEE_TOKEN__=T;}catch(e){}'
    + 'var M={POST:1,PUT:1,DELETE:1,PATCH:1};'
    + 'try{var _f=window.fetch;if(_f&&!_f.__symTok){window.fetch=function(i,n){try{n=n||{};'
    + 'var m=((n&&n.method)||(i&&typeof i===\'object\'&&i.method)||\'GET\').toUpperCase();'
    + 'if(M[m]){var h=new Headers((n&&n.headers)||(i&&typeof i===\'object\'&&i.headers)||{});'
    + 'if(!h.has(\'x-symphonee-token\'))h.set(\'x-symphonee-token\',T);n.headers=h;}}catch(e){}'
    + 'return _f.call(this,i,n);};window.fetch.__symTok=1;}}catch(e){}'
    + 'try{var O=XMLHttpRequest.prototype.open,S=XMLHttpRequest.prototype.send;'
    + 'XMLHttpRequest.prototype.open=function(m){this.__symM=(m||\'GET\').toUpperCase();return O.apply(this,arguments);};'
    + 'XMLHttpRequest.prototype.send=function(){try{if(M[this.__symM])this.setRequestHeader(\'x-symphonee-token\',T);}catch(e){}return S.apply(this,arguments);};}catch(e){}})();</script>';
}

// Insert the snippet right after <head>. Idempotent-ish: callers serve fresh
// file contents each time, so re-injection is not a concern.
function injectHtml(html, token) {
  if (typeof html !== 'string') return html;
  const snippet = htmlSnippet(token);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + '\n' + snippet);
  return snippet + html;
}

function createAuthToken({ runtimePath, port, token } = {}) {
  const value = token || crypto.randomBytes(32).toString('hex');

  // Persist so out-of-process callers (the MCP server, PowerShell helpers run
  // outside a Symphonee-spawned shell) can read it. 0600 = owner-only.
  function persist() {
    if (!runtimePath) return;
    try {
      fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
      const tmp = runtimePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        token: value, port: port || null, pid: process.pid, startedAt: new Date().toISOString(),
      }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, runtimePath);
      try { fs.chmodSync(runtimePath, 0o600); } catch (_) {}
    } catch (_) {}
  }

  function headerToken(req) {
    const h = req && req.headers && req.headers['x-symphonee-token'];
    return Array.isArray(h) ? (h[0] || '') : (h || '');
  }

  // True if the request may proceed: non-mutations always pass (firewall
  // already vetted them); mutations must carry a matching token.
  function isAllowed(req) {
    if (!isMutationMethod(req && req.method)) return true;
    return tokensMatch(headerToken(req), value);
  }

  return {
    value, persist, isAllowed, headerToken,
    htmlSnippet: () => htmlSnippet(value),
    injectHtml: (html) => injectHtml(html, value),
  };
}

module.exports = { createAuthToken, isMutationMethod, tokensMatch, htmlSnippet, injectHtml };
