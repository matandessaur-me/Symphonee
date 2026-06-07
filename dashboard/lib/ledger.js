/**
 * Symphonee -- Action Ledger
 *
 * Append-only, queryable record of every action that flows through the server:
 * API actions (via permGate), git ops, orchestrator worker lifecycle, Mind
 * writes, automation. One JSONL file per space under
 * <repoRoot>/.symphonee/ledger/<space>.jsonl.
 *
 * This is the trust spine of the "Trust + Memory Integrity" arc:
 *   - WHAT did the AI (any CLI / worker) actually do,
 *   - with WHAT permission decision,
 *   - and how did it turn OUT.
 *
 * It is intentionally honest about scope: it records what passes through the
 * Symphonee server (cross-CLI automation, plugins, orchestration, Mind writes,
 * API-driven git/file ops, every permission decision incl. denials). It does
 * NOT see file edits a CLI makes through its own harness -- those are recorded
 * by that CLI. The unique value here is the unified, cross-tool view nobody
 * else has.
 *
 * Phase B layers git checkpoint/undo on top (checkpointId links an entry to a
 * restorable working-tree snapshot). Phase C's Mind auditor consumes file/git
 * entries to target which memories need re-grounding.
 *
 * Design notes:
 *   - Append-only. Outcome corrections are written as small {__patch:id} lines
 *     that query() folds back in, so the file stays an immutable event log.
 *   - Best-effort: record()/patch() must never throw into a caller. A failed
 *     ledger write must never break the action it is recording.
 */

const fs = require('fs');
const path = require('path');

let _dir = null;
let _broadcast = null;
let _seq = 0; // monotonic within a process run; disambiguates same-ms entries

const CATEGORIES = ['api', 'git', 'file', 'terminal', 'plugin', 'cli', 'apps', 'browser', 'mind', 'orchestrator', 'system'];
const OUTCOMES = ['ok', 'error', 'blocked', 'pending'];

function init({ dir, broadcast } = {}) {
  _dir = dir || null;
  _broadcast = typeof broadcast === 'function' ? broadcast : null;
  if (_dir) { try { fs.mkdirSync(_dir, { recursive: true }); } catch (_) {} }
  return module.exports;
}

function _ns(space) {
  const ns = String(space || 'default').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'default';
  return ns;
}
function _file(space) {
  return path.join(_dir, _ns(space) + '.jsonl');
}

/**
 * Record one action. Returns the materialised entry (with id + ts) even when
 * the ledger is not initialised, so callers can rely on the shape.
 */
function record(entry = {}) {
  const e = {
    id: 'act_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    seq: ++_seq,
    actor: entry.actor || 'main',
    space: entry.space || null,
    repo: entry.repo || null,
    category: CATEGORIES.includes(entry.category) ? entry.category : 'system',
    action: entry.action || 'unknown',
    resource: entry.resource != null ? String(entry.resource).slice(0, 500) : null,
    decision: entry.decision || null,            // allow | ask | deny | blocked | null
    outcome: OUTCOMES.includes(entry.outcome) ? entry.outcome : 'ok',
    detail: entry.detail != null ? String(entry.detail).slice(0, 2000) : null,
    taskId: entry.taskId || null,
    checkpointId: entry.checkpointId || null,
  };
  if (!_dir) return e;
  try { fs.appendFileSync(_file(e.space), JSON.stringify(e) + '\n'); } catch (_) {}
  try { if (_broadcast) _broadcast({ type: 'action', entry: e }); } catch (_) {}
  return e;
}

/**
 * Patch an existing entry's mutable fields (typically outcome/detail/checkpointId
 * once the underlying op finishes). Written as an append-only patch line.
 */
function patch(id, space, fields = {}) {
  if (!_dir || !id) return;
  const line = { __patch: id, ...fields, patchedAt: new Date().toISOString() };
  try { fs.appendFileSync(_file(space), JSON.stringify(line) + '\n'); } catch (_) {}
  try { if (_broadcast) _broadcast({ type: 'action-patch', id, fields }); } catch (_) {}
}

function _readSpace(space) {
  let raw;
  try { raw = fs.readFileSync(_file(space), 'utf8'); } catch (_) { return []; }
  const byId = new Map();
  const order = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o.__patch) {
      const t = byId.get(o.__patch);
      if (t) { const { __patch, ...rest } = o; Object.assign(t, rest); }
      continue;
    }
    if (!o.id) continue;
    byId.set(o.id, o);
    order.push(o.id);
  }
  return order.map((id) => byId.get(id)).filter(Boolean);
}

function _allSpaces() {
  try { return fs.readdirSync(_dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)); } catch (_) { return []; }
}

/**
 * Query the ledger. All filters optional. Returns newest-first, capped.
 */
function query({ space, since, until, category, actor, outcome, decision, q, limit = 200 } = {}) {
  if (!_dir) return [];
  let rows = [];
  if (space) rows = _readSpace(space);
  else for (const s of _allSpaces()) rows = rows.concat(_readSpace(s));

  const sinceMs = since ? Date.parse(since) : null;
  const untilMs = until ? Date.parse(until) : null;
  const ql = q ? String(q).toLowerCase() : null;

  rows = rows.filter((r) => {
    if (category && r.category !== category) return false;
    if (actor && r.actor !== actor) return false;
    if (outcome && r.outcome !== outcome) return false;
    if (decision && r.decision !== decision) return false;
    const tMs = Date.parse(r.ts);
    if (sinceMs && !(tMs >= sinceMs)) return false;
    if (untilMs && !(tMs <= untilMs)) return false;
    if (ql) {
      const hay = (String(r.action) + ' ' + String(r.resource || '') + ' ' + String(r.detail || '')).toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });

  rows.sort((a, b) => (Date.parse(b.ts) - Date.parse(a.ts)) || ((b.seq || 0) - (a.seq || 0)));
  const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
  return rows.slice(0, lim);
}

/**
 * Aggregate counts for a quick health/activity summary.
 */
function stats({ space, since } = {}) {
  const rows = query({ space, since, limit: 2000 });
  const byCategory = {}, byOutcome = {}, byActor = {};
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
    byActor[r.actor] = (byActor[r.actor] || 0) + 1;
  }
  return {
    total: rows.length,
    blocked: byOutcome.blocked || 0,
    errors: byOutcome.error || 0,
    byCategory, byOutcome, byActor,
  };
}

module.exports = { init, record, patch, query, stats, CATEGORIES, OUTCOMES };
