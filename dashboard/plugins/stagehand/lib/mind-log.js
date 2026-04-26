/**
 * Mind step-logging for Stagehand actions. Mirrors the browser-use plugin's
 * approach: each successful primitive call posts a `conversation` node back
 * to /api/mind/save-result so future CLI sessions can recall what happened.
 */

'use strict';

const http = require('http');

const PORT = process.env.SYMPHONEE_PORT ? Number(process.env.SYMPHONEE_PORT) : 3800;

function _post(urlPath, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));   // best-effort, never throws
    req.write(payload);
    req.end();
  });
}

async function saveStep({ primitive, prompt, url, result }) {
  const question = `[stagehand:${primitive}] ${prompt || ''}`.slice(0, 240);
  const answer = JSON.stringify({
    primitive,
    url: url || null,
    result: typeof result === 'string' ? result.slice(0, 1500) : result,
  }).slice(0, 4000);
  return _post('/api/mind/save-result', {
    question,
    answer,
    citedNodeIds: [],
    createdBy: 'stagehand',
  });
}

module.exports = { saveStep };
