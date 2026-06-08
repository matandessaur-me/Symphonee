// browser-chat-http -- low-level HTTPS transport for the browser agent's LLM
// calls: abort binding, JSON request, line-delimited streaming, transient-error
// detection, and retry-with-backoff. Self-contained (only needs 'https'). Split
// from browser-agent-chat.js. NOTE: intentionally separate from the apps-side
// transport -- the two have diverged (different default timeouts / stream shape).
const https = require('https');

function bindAbort(req, signal, reject, label) {
  if (!signal) return () => {};
  const onAbort = () => {
    try { req.destroy(new Error(label || 'Request aborted')); } catch (_) {}
    try { reject(new Error(label || 'Request aborted')); } catch (_) {}
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    try { signal.removeEventListener('abort', onAbort); } catch (_) {}
  };
}

function isAbortError(err) {
  const msg = String((err && err.message) || err || '');
  return msg.includes('request aborted') || msg.includes('stream aborted') || msg.includes('aborted');
}

function httpJson({ hostname, path, method = 'POST', headers = {}, body, timeoutMs = 60000, signal }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
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
    const cleanupAbort = bindAbort(req, signal, reject, `${hostname} request aborted`);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(hostname + ' request timed out')); });
    if (payload) req.write(payload);
    req.end();
    req.on('close', cleanupAbort);
  });
}

function httpStream({ hostname, path, method = 'POST', headers = {}, body, onChunk, timeoutMs = 90000, signal }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method, hostname, path,
      headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end', () => reject(new Error(`${hostname} ${res.statusCode}: ${err.slice(0, 600)}`)));
        return;
      }
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) { try { onChunk(line); } catch (_) {} }
      });
      res.on('end', () => {
        if (buf.trim()) { try { onChunk(buf); } catch (_) {} }
        resolve();
      });
      res.on('error', reject);
    });
    const cleanupAbort = bindAbort(req, signal, reject, `${hostname} stream aborted`);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(hostname + ' stream timed out')));
    if (payload) req.write(payload);
    req.end();
    req.on('close', cleanupAbort);
  });
}

function isTransientError(e) {
  const msg = e.message || '';
  return (
    msg.includes('429') ||
    msg.includes('SSL') ||
    msg.includes('BAD_RECORD_MAC') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('socket hang up') ||
    msg.includes('timed out')
  );
}

async function httpJsonWithRetry(opts, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await httpJson(opts); } catch (e) {
      lastErr = e;
      if (isTransientError(e) && attempt < maxRetries) {
        // Longer backoff for rate limits; short backoff for network glitches.
        const wait = e.message && e.message.includes('429')
          ? (attempt + 1) * 15000
          : (attempt + 1) * 1500;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

module.exports = { bindAbort, isAbortError, httpJson, httpStream, isTransientError, httpJsonWithRetry };
