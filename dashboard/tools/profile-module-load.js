/**
 * Startup profiler -- module require() cost.
 *
 * The dominant, main-thread-blocking part of Symphonee boot is the synchronous
 * `require('./server')` in electron-main.js: every mount*() and ~22 top-level
 * requires run before the event loop is free again. This harness measures the
 * require() half of that cost WITHOUT booting the real server (no port bind, no
 * mount side effects), so it is safe to run while the app is already up.
 *
 * It requires each dependency in the SAME ORDER server.js does, in a single
 * process, so each number is the MARGINAL cost (shared transitive deps are
 * paid once by whichever module pulls them first) -- which mirrors real boot.
 *
 * Run:  node dashboard/tools/profile-module-load.js
 * Out:  console table + .ai-workspace/startup-traces/module-load-<n>.json
 */
'use strict';
const path = require('path');
const fs = require('fs');

// Resolve relative to dashboard/ regardless of CWD so server.js's own relative
// require ids ('./mind', './utils/...') resolve identically.
const dashboardDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(dashboardDir, '..');

// Mirror of server.js's top-level require order (see require map in
// docs/perf/startup-profiling.md). node-pty + ws are the heavy native/3rd-party
// deps loaded first; the rest are first-party subsystems.
const MODULES = [
  // third-party / native (loaded at the very top of server.js)
  'ws',
  'node-pty',
  // first-party utils
  './utils/git-async',
  './utils/swr-cache',
  './utils/atomic-write',
  './utils/busy-guard',
  './instruction-audit',
  // first-party subsystems (in server.js require order)
  './plugins-core/plugin-loader',
  './orchestrator',
  './permissions',
  './mcp/mcp-client',
  './graph/graph-runs',
  './model-router',
  './recipes',
  './hybrid-search',
  './repo-map',
  './learnings/learnings',
  './jobs-scheduler',
  './mind',
  './brain/sequences',
  './brain',
  './browser-agent',
  './browser-agent-chat',
  './browser-router',
  './apps-agent',
];

function resolveId(id) {
  if (id.startsWith('.')) return path.join(dashboardDir, id);
  // bare specifier -> resolve from dashboard's node_modules
  return require.resolve(id, { paths: [dashboardDir, repoRoot] });
}

const results = [];
const overallStart = process.hrtime.bigint();

for (const id of MODULES) {
  const target = resolveId(id);
  const t0 = process.hrtime.bigint();
  let ok = true;
  let err = null;
  try {
    require(target);
  } catch (e) {
    ok = false;
    err = e && e.message ? e.message : String(e);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.push({ id, ms: Math.round(ms * 100) / 100, ok, err });
}

const totalMs = Number(process.hrtime.bigint() - overallStart) / 1e6;

// Sort a copy by cost for the headline; keep `results` in boot order for JSON.
const byCost = [...results].sort((a, b) => b.ms - a.ms);

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log('\nMODULE require() COST (marginal, server.js boot order)\n');
console.log(pad('module', 26), padL('ms', 9), '  status');
console.log('-'.repeat(50));
for (const r of results) {
  console.log(pad(r.id, 26), padL(r.ms.toFixed(2), 9), '  ', r.ok ? 'ok' : ('FAIL: ' + r.err));
}
console.log('-'.repeat(50));
console.log(pad('TOTAL require() time', 26), padL(totalMs.toFixed(2), 9), 'ms');

console.log('\nTOP 8 BY COST\n');
for (const r of byCost.slice(0, 8)) {
  console.log('  ' + padL(r.ms.toFixed(2), 9) + ' ms   ' + r.id);
}

const outDir = path.join(repoRoot, '.ai-workspace', 'startup-traces');
try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
// No Date.now() games needed in a plain node run; stamp with an incrementing
// index based on existing files so successive runs do not clobber.
let idx = 0;
try { idx = fs.readdirSync(outDir).filter(f => f.startsWith('module-load-')).length; } catch (_) {}
const outFile = path.join(outDir, `module-load-${idx}.json`);
fs.writeFileSync(outFile, JSON.stringify({
  kind: 'module-load-profile',
  node: process.version,
  totalMs: Math.round(totalMs * 100) / 100,
  bootOrder: results,
  byCost,
}, null, 2));
console.log('\nWrote ' + outFile + '\n');
