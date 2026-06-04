/**
 * apps-http.js - Shared HTTPS utilities for the apps subsystem.
 *
 * Extracted from apps-agent-chat.js so that apps-recipe-runner.js can
 * import httpJson without pulling in the full chat module and creating the
 * circular dependency:
 *   apps-recipe-runner -> apps-agent-chat -> apps-self-healer -> apps-recipe-runner
 *
 * This module has zero intra-app dependencies (only Node built-ins).
 */

const https = require('https');

// Shared keep-alive agent. agent:false opens a fresh TCP+TLS handshake per
// request, which on Windows occasionally surfaces a spurious
// SSLV3_ALERT_BAD_RECORD_MAC when a handshake races a pending socket close.
// Reusing sockets removes that window and cuts per-step latency too.
const SHARED_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 4,
  maxFreeSockets: 2,
  timeout: 120000,
});

function bindAbort(req, signal, reject, label) {
  if (!signal) return () => {};
  const onAbort = () => {
    try { req.destroy(new Error(label || 'Request aborted')); } catch (_) {}
    try { reject(new Error(label || 'Request aborted')); } catch (_) {}
  };
  if (signal.aborted) { onAbort(); return () => {}; }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { try { signal.removeEventListener('abort', onAbort); } catch (_) {} };
}

function isAbortError(err) {
  const msg = String((err && err.message) || err || '');
  return msg.includes('request aborted') || msg.includes('stream aborted') || msg.includes('aborted');
}

function isTransientError(e) {
  if (e.statusCode === 429) return true;
  const code = e.code || '';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return true;
  const msg = e.message || '';
  return msg.includes('429') || msg.includes('SSL') || msg.includes('BAD_RECORD_MAC') ||
    msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') ||
    msg.includes('socket hang up') || msg.includes('timed out');
}

function httpJson({ hostname, path, method = 'POST', headers = {}, body, timeoutMs = 90000, signal }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error(`${hostname} request aborted`)); return; }
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
      agent: SHARED_HTTPS_AGENT,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          const err = new Error(`${hostname} ${res.statusCode}: ${data.slice(0, 600)}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    const cleanup = bindAbort(req, signal, reject, `${hostname} request aborted`);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(hostname + ' request timed out')));
    if (payload) req.write(payload);
    req.end();
    req.on('close', cleanup);
  });
}

function httpStreamOnce(opts, onStreamStarted) {
  const { hostname, path, method = 'POST', headers = {}, body, onChunk, timeoutMs = 180000, signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error(`${hostname} stream aborted`)); return; }
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
      agent: SHARED_HTTPS_AGENT,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errBody = '';
        res.on('data', c => { errBody += c; });
        res.on('end', () => {
          const e = new Error(`${hostname} ${res.statusCode}: ${errBody.slice(0, 600)}`);
          e.statusCode = res.statusCode;
          reject(e);
        });
        return;
      }
      let buf = '';
      let streamStartedFired = false;
      res.on('data', chunk => {
        if (onStreamStarted && !streamStartedFired) {
          streamStartedFired = true;
          try { onStreamStarted(); } catch (_) {}
        }
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) { try { onChunk(line); } catch (_) {} }
      });
      res.on('end', () => { if (buf.trim()) { try { onChunk(buf); } catch (_) {} } resolve(); });
      res.on('error', reject);
    });
    const cleanup = bindAbort(req, signal, reject, `${hostname} stream aborted`);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(hostname + ' stream timed out')));
    if (payload) req.write(payload);
    req.end();
    req.on('close', cleanup);
  });
}

async function httpStream(opts, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    let started = false;
    try {
      return await httpStreamOnce(opts, () => { started = true; });
    } catch (e) {
      lastErr = e;
      if (!started && isTransientError(e) && i < maxRetries) {
        const wait = e.message && e.message.includes('429') ? (i + 1) * 15000 : (i + 1) * 1500;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function httpJsonWithRetry(opts, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await httpJson(opts); } catch (e) {
      lastErr = e;
      if (isTransientError(e) && i < maxRetries) {
        const wait = e.message && e.message.includes('429') ? (i + 1) * 15000 : (i + 1) * 1500;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

module.exports = {
  httpJson,
  httpJsonWithRetry,
  httpStream,
  bindAbort,
  isTransientError,
  isAbortError,
};
