/**
 * startup-trace.js -- lightweight, always-on boot profiler.
 *
 * One shared module instance for the whole process (electron-main.js requires
 * server.js into the SAME process, so both sides share this clock). Cost is a
 * handful of performance.now() reads plus one file write when boot settles --
 * sub-millisecond, safe to leave on in production.
 *
 * Timeline origin: performance.now() is milliseconds since process start, so
 * every mark is "ms since the process launched" with no extra bookkeeping.
 *
 * Usage:
 *   const trace = require('./startup-trace');
 *   trace.mark('server:require:start');
 *   ...
 *   trace.mark('server:listening');
 *   trace.flush('listening');   // writes boot-<n>.json; safe to call repeatedly
 *
 * Disable entirely with SY_STARTUP_TRACE=0.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ENABLED = process.env.SY_STARTUP_TRACE !== '0';
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, '.ai-workspace', 'startup-traces');

const marks = [];
let flushed = false;

function mark(name, meta) {
  if (!ENABLED) return;
  try {
    marks.push({ name: String(name), t: performance.now(), meta: meta || null });
  } catch (_) { /* never let tracing break boot */ }
}

// Compute deltas between consecutive marks and emit a JSON document. Called on
// the 'listening' event and again on the dashboard's did-finish-load so the
// file always reflects the latest known phase. Last write wins.
function flush(reason) {
  if (!ENABLED) return null;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const ordered = [...marks].sort((a, b) => a.t - b.t);
    const rows = ordered.map((m, i) => ({
      name: m.name,
      atMs: Math.round(m.t * 100) / 100,
      deltaMs: i === 0 ? 0 : Math.round((m.t - ordered[i - 1].t) * 100) / 100,
      meta: m.meta || undefined,
    }));
    const doc = {
      kind: 'boot-trace',
      reason: reason || null,
      node: process.version,
      electron: process.versions && process.versions.electron || null,
      underElectron: !!process.env.ELECTRON,
      totalMs: rows.length ? rows[rows.length - 1].atMs : 0,
      marks: rows,
    };
    // Stable filename for the in-progress boot so repeated flushes overwrite
    // rather than pile up. Promote to an indexed file once boot is "done".
    const live = path.join(outDir, 'boot-latest.json');
    fs.writeFileSync(live, JSON.stringify(doc, null, 2));
    if (reason === 'dashboard-loaded' && !flushed) {
      flushed = true;
      let idx = 0;
      try { idx = fs.readdirSync(outDir).filter(f => /^boot-\d+\.json$/.test(f)).length; } catch (_) {}
      fs.writeFileSync(path.join(outDir, `boot-${idx}.json`), JSON.stringify(doc, null, 2));
    }
    return doc;
  } catch (_) {
    return null;
  }
}

module.exports = { mark, flush, get marks() { return marks; }, ENABLED };
