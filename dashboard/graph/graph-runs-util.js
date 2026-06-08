// graph-runs-util -- pure helpers for the graph-run engine: deep config merge,
// {{var}} template rendering, dotted-path read, sandboxed condition eval (vm),
// skip-propagation reachability, the localhost API client, and sleep. Split from
// graph-runs.js so they can be unit-tested directly; the engine imports them.
const http = require('http');
const vm = require('vm');

function deepMerge(a, b) {
  if (Array.isArray(b)) return b.slice();
  if (b === null || typeof b !== 'object') return b;
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
    try { return String(readPath(vars, path) ?? ''); } catch (_) { return ''; }
  });
}

function readPath(obj, p) {
  const parts = String(p).split('.').map(s => s.trim()).filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function evalSafe(expr, state) {
  return vm.runInNewContext(`(${expr})`, { state }, { timeout: 200 });
}

// Compute the set of nodes that become unreachable when `startId` is skipped,
// given that `alreadySkipped` is the running skip set. A node is unreachable
// only if it has at least one dependency AND every dependency is in the skip
// set. Iterated to a fixed point so chained merges work too.
function unreachableFrom(nodes, startId, alreadySkipped = []) {
  const skip = new Set([...alreadySkipped, startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (skip.has(n.id)) continue;
      const deps = n.dependsOn || [];
      if (!deps.length) continue; // root nodes are never skipped by propagation
      if (deps.every(d => skip.has(d))) {
        skip.add(n.id);
        changed = true;
      }
    }
  }
  return Array.from(skip);
}

function apiRequest(host, port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host, port, path: pathname, method,
      headers: Object.assign({ Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { body: parsed, statusCode: res.statusCode }));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { deepMerge, renderTemplate, readPath, evalSafe, unreachableFrom, apiRequest, sleep };
