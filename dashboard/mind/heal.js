/**
 * Self-healing watchdog — Mind tries to fix its own degraded state.
 *
 * Mind has several ways to drift: nodes missing vectors (so semantic recall
 * silently degrades), locks orphaned by killed processes (so writes start
 * 409-ing), the graph getting old without any rebuild touching it, the
 * instruction audit baseline drifting from the live corpus. Each of these
 * has a manual recovery path, but expecting the user to notice and run them
 * is exactly the friction we want to remove.
 *
 * Each check runs in isolation and returns a structured finding. The
 * watchdog auto-applies the fix when safe (defined as: reversible, no
 * cross-PC side effects, fast). For irreversible / sensitive fixes the
 * finding is surfaced as a diagnostic and the user (or a CLI) decides.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const lock = require('./lock');
const { VectorStore } = require('./vectors');
const embeddings = require('./embeddings');

const STALE_GRAPH_MS = 6 * 60 * 60 * 1000;   // 6h since last build = stale
const STALE_LOCK_MS = 15 * 60 * 1000;        // 15min lock with dead holder = orphaned

async function _embedMissingNodes({ repoRoot, space, getAiApiKeys, maxNodes = 25 }) {
  try { embeddings.setAvailableApiKeys(getAiApiKeys ? getAiApiKeys() : {}); } catch (_) {}
  const vs = new VectorStore(repoRoot, space);
  const loaded = vs.load();
  if (!loaded || vs.count() === 0) {
    return { ok: false, reason: 'vector-store-empty', healed: 0 };
  }
  const g = store.loadGraph(repoRoot, space);
  if (!g) return { ok: false, reason: 'no-graph', healed: 0 };
  const have = new Set(vs.ids);
  // Eligible for embedding: nodes with text content. We embed memories,
  // conversations, drawers, learnings, notes, concepts. Skip code/file/
  // entity nodes (their semantics come from edges, not vectors).
  const eligibleKinds = new Set(['memory', 'conversation', 'drawer', 'learning', 'note', 'concept', 'recipe']);
  const candidates = [];
  for (const n of g.nodes) {
    if (!eligibleKinds.has(n.kind)) continue;
    if (have.has(n.id)) continue;
    const text = [n.label, n.body, n.answer].filter(Boolean).join('\n\n').slice(0, 4000);
    if (!text.trim()) continue;
    candidates.push({ id: n.id, text });
    if (candidates.length >= maxNodes) break;
  }
  if (!candidates.length) return { ok: true, healed: 0, reason: 'no-missing-nodes' };
  const provider = vs.provider || embeddings.pickProvider();
  if (!provider) return { ok: false, reason: 'no-embedding-provider', healed: 0, missing: candidates.length };
  let healed = 0;
  for (const c of candidates) {
    try {
      const vec = await embeddings.embedSingle(c.text, { provider, model: vs.model || undefined });
      if (!vec) continue;
      vs.upsert(c.id, vec);
      healed++;
    } catch (_) { /* one bad embed must not block the rest */ }
  }
  if (healed > 0) vs.save();
  return { ok: true, healed, attempted: candidates.length, provider };
}

function _clearOrphanedLocks() {
  // We only auto-clear locks held by dead processes. Even if a lock is
  // stale-by-refresh, a live process might just be doing slow I/O — the
  // watchdog must not kill it. terminateHolder handles dead-PID cleanup
  // safely (its branch order: dead -> unlink, alive -> kill); we gate
  // entry on isAlive ourselves to keep the kill branch unreachable from
  // here.
  const records = lock.listAll();
  const cleared = [];
  for (const rec of records) {
    if (!rec.pid) continue;
    let alive = false;
    try { process.kill(rec.pid, 0); alive = true; } catch (_) { alive = false; }
    if (alive) continue;
    try {
      const result = lock.terminateHolder(rec.space, rec.op);
      if (result && result.terminated) {
        cleared.push({ space: rec.space, op: rec.op, reason: result.reason });
      }
    } catch (_) { /* keep going */ }
  }
  return { ok: true, healed: cleared.length, cleared };
}

function _checkGraphFreshness({ repoRoot, space }) {
  const stats = store.statsFor(repoRoot, space);
  if (!stats) return { ok: true, status: 'empty', healed: 0 };
  const lastBuild = Date.parse(stats.lastBuildAt || '');
  if (Number.isNaN(lastBuild)) return { ok: true, status: 'unknown', healed: 0 };
  const ageMs = Date.now() - lastBuild;
  if (ageMs > STALE_GRAPH_MS) {
    return {
      ok: true, status: 'stale', healed: 0, ageHours: Math.round(ageMs / 3600000),
      hint: 'graph older than 6h — consider POST /api/mind/update or wait for the next watcher-triggered rebuild',
    };
  }
  return { ok: true, status: 'fresh', healed: 0, ageHours: Math.round(ageMs / 3600000) };
}

function _detectOrphanNodes({ repoRoot, space, sampleLimit = 50 }) {
  const g = store.loadGraph(repoRoot, space);
  if (!g) return { ok: true, healed: 0, count: 0 };
  const referenced = new Set();
  for (const e of g.edges || []) { referenced.add(e.source); referenced.add(e.target); }
  const orphans = [];
  for (const n of g.nodes) {
    if (n.kind === 'memory' || n.kind === 'note') continue; // these are valid standalone
    if (!referenced.has(n.id)) orphans.push({ id: n.id, kind: n.kind, label: (n.label || '').slice(0, 80) });
    if (orphans.length >= sampleLimit) break;
  }
  return { ok: true, healed: 0, count: orphans.length, sample: orphans.slice(0, 10) };
}

/**
 * Run all safe self-healing checks in one pass. Returns a structured
 * findings object. Safe = auto-applies fixes that are reversible / cheap.
 */
async function healOnce({ repoRoot, space, getAiApiKeys, opts = {} } = {}) {
  if (!repoRoot || !space) return { ok: false, error: 'repoRoot and space required' };
  const findings = {};
  findings.locks = _clearOrphanedLocks();
  findings.graphFreshness = _checkGraphFreshness({ repoRoot, space });
  findings.orphanNodes = _detectOrphanNodes({ repoRoot, space });
  // Embedding backfill is the most valuable healing — semantic recall
  // silently degrades without it. Bounded per pass so we don't burn an
  // embedding-API budget in one tick.
  if (opts.skipEmbed !== true) {
    findings.missingVectors = await _embedMissingNodes({ repoRoot, space, getAiApiKeys, maxNodes: opts.maxNodes || 25 });
  }
  const totalHealed = Object.values(findings).reduce((s, f) => s + (f && f.healed ? f.healed : 0), 0);
  return { ok: true, healed: totalHealed, findings, ranAt: new Date().toISOString() };
}

/**
 * Scheduler. Runs every TICK_MS. Cheap when nothing's broken (just a few
 * filesystem stats); expensive only when there's work to heal.
 */
function startHealingScheduler({ repoRoot, getSpace, getAiApiKeys, broadcast }) {
  const TICK_MS = 5 * 60 * 1000;       // 5 minutes between sweeps
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const space = getSpace ? getSpace() : '_global';
      const result = await healOnce({ repoRoot, space, getAiApiKeys });
      if (result.healed > 0 && broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'self-healed', healed: result.healed, findings: result.findings } });
      }
    } catch (e) {
      console.warn('[mind/heal] error:', e.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  // Initial sweep 60s after boot — gives the rest of the server time to
  // settle (locks from a previous run, missing vectors after restart).
  const bootTimer = setTimeout(() => { tick().catch(() => {}); }, 60_000);
  return () => { clearInterval(timer); clearTimeout(bootTimer); };
}

module.exports = { healOnce, startHealingScheduler };
