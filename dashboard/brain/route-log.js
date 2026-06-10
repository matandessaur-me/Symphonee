/**
 * Route-decision log - Stage-0 instrumentation of the conductor.
 *
 * The brain already records what it DECIDED in an in-memory ring buffer
 * (brain/index.js -> decisionLog), but that buffer is capped at 200 entries
 * and dies on restart. Stage 0 of the Symphonee 2.0 plan needs something the
 * ring buffer cannot give: a DURABLE record of every qwen2.5:1.5b triage
 * recall-vs-escalate decision on real traffic, so Stage 4 (the conductor) can
 * later measure routing accuracy on logged history and so we can SEE the
 * conductor's choices before deepening the cognition.
 *
 * This module is the durable sink. It mirrors outcomes.js deliberately: an
 * append-only JSONL file under `.symphonee/`, a tolerant reader, a cached
 * aggregate, and a prune. Behaviour change elsewhere is zero - the planner
 * still routes exactly as before; we only write down what it did.
 *
 * One record per planner call. The recall-vs-escalate signal (routeClass /
 * escalateReason) is produced by planner.classifyRoute so the SEMANTICS live
 * with the planner; this file only persists and aggregates.
 *
 * Storage: append-only JSONL at `.symphonee/route-decisions.jsonl`. The
 * `.symphonee/` directory is gitignored, so logged traffic never lands in a
 * commit.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const perf = require('./perf');

const ROUTE_CLASSES = new Set(['stay', 'escalate', 'stay-fallback', 'error']);
const MAX_LINES_KEPT = 50_000;

function routeLogFile(repoRoot) {
  return path.join(repoRoot, '.symphonee', 'route-decisions.jsonl');
}
function ensureDir(file) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
}
function _safeStr(v, max = 240) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : String(v);
  return s.length > max ? s.slice(0, max) : s;
}
function _num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * Append one route-decision record. Takes the raw planRoute() result plus the
 * already-computed classification (from planner.classifyRoute) and a few
 * pieces of call-site context the planner result does not carry (the input
 * text, the source, the wall-clock the caller measured).
 *
 * Defensive: never throws on a bad write - instrumentation must not be able to
 * break a real request. Returns the written record (or null on failure) so the
 * caller can correlate, but callers generally ignore the return.
 *
 * @param repoRoot   absolute path to the active repo
 * @param entry      {
 *                     decisionId, input, source,
 *                     plan,                // raw planRoute() result
 *                     classification,      // { routeClass, escalateReason }
 *                     tookMs               // caller-measured wall clock
 *                   }
 */
function record(repoRoot, entry = {}) {
  if (!repoRoot) return null;
  const file = routeLogFile(repoRoot);
  const plan = entry.plan || {};
  const cls = entry.classification || {};
  const decision = plan.decision || {};
  const rec = {
    ts: Date.now(),
    decisionId: _safeStr(entry.decisionId, 64),
    source: _safeStr(entry.source, 32) || 'think',
    input: _safeStr(entry.input, 240),
    // The recall-vs-escalate signal - the whole point of this log.
    routeClass: ROUTE_CLASSES.has(cls.routeClass) ? cls.routeClass : 'error',
    escalateReason: _safeStr(cls.escalateReason, 32),
    escalated: !!plan.escalated,
    forceEscalated: !!plan.forceEscalated,
    stage: _safeStr(plan.stage, 32),
    // Raw signals so Stage 4 can re-derive thresholds without re-running.
    triageConfidence: _num(plan.triageConfidence) != null
      ? _num(plan.triageConfidence)
      : _num(decision.confidence),
    escalationThreshold: _num(entry.escalationThreshold),
    // What the decision actually was, snapshotted (decision log ages out).
    intent: _safeStr(decision.intent, 64),
    primaryCli: _safeStr(decision.primary_cli, 32),
    triageModel: _safeStr(plan.triageModel || plan.model, 48),
    model: _safeStr(plan.model, 48),
    patchCount: Array.isArray(plan.patches) ? plan.patches.length : 0,
    tookMs: _num(entry.tookMs),
    ok: plan.ok !== false,
  };
  try {
    ensureDir(file);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    _invalidateStats(repoRoot);
    perf.bump('routelog.appended');
    return rec;
  } catch (_) {
    perf.bump('routelog.append.errors');
    return null;
  }
}

/**
 * Load route-decision records, ascending by ts. Tolerates partial / malformed
 * lines (a half-written final line after a crash, etc).
 */
function readRouteLog(repoRoot, { sinceMs = null, untilMs = null } = {}) {
  const file = routeLogFile(repoRoot);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (typeof rec.ts !== 'number') continue;
      if (sinceMs && rec.ts < sinceMs) continue;
      if (untilMs && rec.ts > untilMs) continue;
      out.push(rec);
    } catch (_) { /* skip */ }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Cache the unfiltered aggregate. Like outcomes.js, getStats() parses the whole
// file; cache it and invalidate on every append + prune so it stays exact.
const _statsCache = new Map();  // repoRoot -> { stats, builtAt }
function _invalidateStats(repoRoot) { _statsCache.delete(repoRoot); }

/**
 * Aggregate the recall-vs-escalate picture. Returns:
 *
 *   total          - n records
 *   byRouteClass   - { stay, escalate, stay-fallback, error }  (counts)
 *   escalationRate - escalate / (stay + escalate)  (the headline number;
 *                    fallbacks/errors excluded from the denominator because
 *                    they were not a clean stay-or-escalate choice)
 *   byEscalateReason - { low-confidence, force-patch, escalation-failed }
 *   byIntent       - { [intent]: { stay, escalate, escalationRate, n } }
 *   confidence     - { stayMean, escalateMean } over recorded triageConfidence
 *   latency        - { stayMeanMs, escalateMeanMs } over tookMs
 *
 * Pure aggregation - no opinion about whether the routing was GOOD (that is
 * what outcomes.js + the eval are for). This just shows what happened.
 */
function getStats(repoRoot, opts = {}) {
  const isFiltered = (opts && (opts.sinceMs != null || opts.untilMs != null));
  if (!isFiltered && _statsCache.has(repoRoot)) {
    perf.bump('routelog.stats.cache.hit');
    return _statsCache.get(repoRoot).stats;
  }
  perf.bump('routelog.stats.cache.miss');
  const records = readRouteLog(repoRoot, opts);

  const byRouteClass = { stay: 0, escalate: 0, 'stay-fallback': 0, error: 0 };
  const byEscalateReason = Object.create(null);
  const byIntent = Object.create(null);
  let stayConfSum = 0, stayConfN = 0, escConfSum = 0, escConfN = 0;
  let stayMsSum = 0, stayMsN = 0, escMsSum = 0, escMsN = 0;

  for (const r of records) {
    const rc = ROUTE_CLASSES.has(r.routeClass) ? r.routeClass : 'error';
    byRouteClass[rc] += 1;
    if (r.escalateReason) {
      byEscalateReason[r.escalateReason] = (byEscalateReason[r.escalateReason] || 0) + 1;
    }
    if (r.intent) {
      const b = byIntent[r.intent] || (byIntent[r.intent] = { stay: 0, escalate: 0, 'stay-fallback': 0, error: 0, n: 0 });
      b[rc] += 1;
      b.n += 1;
    }
    if (typeof r.triageConfidence === 'number') {
      if (rc === 'escalate') { escConfSum += r.triageConfidence; escConfN += 1; }
      else if (rc === 'stay') { stayConfSum += r.triageConfidence; stayConfN += 1; }
    }
    if (typeof r.tookMs === 'number') {
      if (rc === 'escalate') { escMsSum += r.tookMs; escMsN += 1; }
      else if (rc === 'stay') { stayMsSum += r.tookMs; stayMsN += 1; }
    }
  }

  const cleanChoices = byRouteClass.stay + byRouteClass.escalate;
  const _mean = (sum, n) => (n ? Math.round((sum / n) * 1000) / 1000 : null);
  const _rate = (esc, stay) => {
    const d = esc + stay;
    return d ? Math.round((esc / d) * 1000) / 1000 : null;
  };

  for (const k of Object.keys(byIntent)) {
    const b = byIntent[k];
    b.escalationRate = _rate(b.escalate, b.stay);
  }

  const stats = {
    total: records.length,
    byRouteClass,
    escalationRate: cleanChoices ? Math.round((byRouteClass.escalate / cleanChoices) * 1000) / 1000 : null,
    byEscalateReason,
    byIntent,
    confidence: { stayMean: _mean(stayConfSum, stayConfN), escalateMean: _mean(escConfSum, escConfN) },
    latency: { stayMeanMs: _mean(stayMsSum, stayMsN), escalateMeanMs: _mean(escMsSum, escMsN) },
  };
  if (!isFiltered) _statsCache.set(repoRoot, { stats, builtAt: Date.now() });
  return stats;
}

/**
 * Prune records older than `olderThanDays`, keeping at most `maxLines`.
 * Read-rewrite cycle, same shape as outcomes.pruneOld.
 */
function pruneOld(repoRoot, { olderThanDays = 365, maxLines = MAX_LINES_KEPT } = {}) {
  const file = routeLogFile(repoRoot);
  if (!fs.existsSync(file)) return { kept: 0, dropped: 0 };
  const sinceMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const all = readRouteLog(repoRoot, {});
  const kept = all.filter(r => r.ts >= sinceMs).slice(-maxLines);
  const dropped = all.length - kept.length;
  const next = kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '');
  fs.writeFileSync(file, next, 'utf8');
  _invalidateStats(repoRoot);
  return { kept: kept.length, dropped };
}

module.exports = {
  ROUTE_CLASSES,
  MAX_LINES_KEPT,
  routeLogFile,
  record,
  readRouteLog,
  getStats,
  pruneOld,
};
