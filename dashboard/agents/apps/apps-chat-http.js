// apps-chat-http -- low-level HTTP/HTTPS transport for the apps agent's LLM
// calls: a keep-alive HTTPS agent, abort binding, JSON request, line-delimited
// streaming (with a pre-first-byte retry so we never double-emit tokens), and
// retry-with-backoff. Self-contained (only needs http/https). Split from
// apps-agent-chat.js. NOTE: deliberately separate from browser-chat-http -- the
// two diverged (apps supports http+port+protocol switching and a shared agent;
// browser is https-only with different default timeouts).
const https = require('https');
const http = require('http');
const { bindAbort, isAbortError, isTransientError } = require('../chat-http-shared');

const SHARED_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 4,
  maxFreeSockets: 2,
  timeout: 120000,
});

function httpJson({ hostname, path, port, protocol = 'https', method = 'POST', headers = {}, body, timeoutMs = 90000, signal }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const transport = protocol === 'http' ? http : https;
    const reqOpts = {
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    };
    if (port) reqOpts.port = port;
    if (transport === https) reqOpts.agent = SHARED_HTTPS_AGENT;
    const req = transport.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`${hostname} ${res.statusCode}: ${data.slice(0, 600)}`));
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
  const { hostname, path, port, protocol = 'https', method = 'POST', headers = {}, body, onChunk, timeoutMs = 180000, signal } = opts;
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const transport = protocol === 'http' ? http : https;
    const reqOpts = {
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    };
    if (port) reqOpts.port = port;
    if (transport === https) reqOpts.agent = SHARED_HTTPS_AGENT;
    const req = transport.request(reqOpts, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end', () => reject(new Error(`${hostname} ${res.statusCode}: ${err.slice(0, 600)}`)));
        return;
      }
      let buf = '';
      res.on('data', chunk => {
        if (onStreamStarted) { try { onStreamStarted(); } catch (_) {} }
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

// Retry transient failures (SSL BAD_RECORD_MAC, ECONNRESET, 429) that happen
// before any stream data arrives. Once the server has started emitting
// tokens, restarting would double-emit, so we give up and surface the error.
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


module.exports = { bindAbort, isAbortError, httpJson, httpStreamOnce, httpStream, isTransientError, httpJsonWithRetry };
