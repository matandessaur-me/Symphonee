/**
 * Symphonee sequence recorder - captures ordered action traces.
 *
 * The brain's third faculty after intent and routing: watching what the
 * user actually does and persisting it as session traces so the synthesizer
 * can later cluster recurring shapes and propose new recipes / workflows.
 *
 * Storage: append-only JSONL at `.symphonee/sequences.jsonl`. Cheap, easy
 * to scan, survives Mind rebuilds. Persistence is per-event - no batching,
 * no daemon, just write-on-record. Pruning is on-demand only (no clock).
 *
 * Session boundary: events within IDLE_GAP_MS of the previous event in the
 * same repo belong to the same session. A larger gap closes the previous
 * session and opens a new one. Sessions are not stored as discrete records
 * on disk - the loader reconstructs them by scanning timestamps. Keeps the
 * write path simple.
 *
 * Events recorded today:
 *   - file-change  { kind, repo, file }
 *   - qa-saved     { kind, repo, detail: question | answer-preview }
 *   - drawer-turn  { kind, repo, detail }
 *   - git-event    { kind, repo, detail }
 *   - learning     { kind, repo, detail }
 *   - knowledge    { kind, repo, detail }  (catch-all from notifyKnowledgeEvent)
 *
 * Each record is { ts, kind, repo, file, detail, source }.
 *
 * No event-bus subscription happens inside this module. Callers (server.js,
 * other modules) call recordEvent() explicitly. Same single-fan-in pattern
 * we used for intent.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const IDLE_GAP_MS = 10 * 60 * 1000;   // 10 minutes -> new session
const MAX_LINES_KEPT = 50_000;        // hard cap to keep the file readable
const PRUNE_DEFAULT_DAYS = 30;        // prune sessions older than this

function sequencesFile(repoRoot) {
  return path.join(repoRoot, '.symphonee', 'sequences.jsonl');
}

function ensureDir(file) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
}

function _safeKind(k) {
  const s = String(k || 'event').toLowerCase();
  return s.slice(0, 32);
}

function _safeStr(v, max = 200) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// Per-repo append queue. recordEvent() is called from hot event paths
// (mind.notifyKnowledgeEvent, file watcher, drawer writes). A synchronous
// fs.appendFileSync there would block the Node event loop for every
// burst. Instead we buffer in memory and flush via async fs.appendFile;
// when the in-flight write resolves we flush whatever else queued up.
// Order is preserved per repo because each repo's queue serializes its
// own writes.
//
// Invariant: every recorded event lives in EITHER `buffer` (queued, not
// yet handed to disk) OR `inFlight` (handed off to fs.appendFile, not
// yet confirmed) OR on disk. loadEvents reads all three so synchronous
// readers immediately after a recordEvent see the new record.
const _writeQueues = new Map();   // repoRoot -> { buffer: [], inFlight: [], flushing: bool }
function _scheduleFlush(repoRoot, file) {
  const q = _writeQueues.get(repoRoot);
  if (!q || q.flushing || !q.buffer.length) return;
  q.flushing = true;
  q.inFlight = q.buffer;
  q.buffer = [];
  const chunk = q.inFlight.join('');
  fs.appendFile(file, chunk, 'utf8', (err) => {
    q.flushing = false;
    q.inFlight = [];
    if (err) {
      // never throw - sequence recording must never break the caller.
      // We DO swallow silently because the alternative (logging on every
      // failed write) would itself spam the console during disk pressure.
    }
    // If more arrived during the write, flush again.
    if (q.buffer.length) _scheduleFlush(repoRoot, file);
  });
}

/**
 * Record a single event. Buffers in memory and flushes asynchronously so
 * the calling event path returns immediately. Order is preserved per
 * repo. If the disk write fails we swallow - sequence recording is
 * advisory; never block the caller.
 */
function recordEvent(repoRoot, event) {
  if (!repoRoot || !event) return false;
  const file = sequencesFile(repoRoot);
  ensureDir(file);
  const record = {
    ts: Date.now(),
    kind: _safeKind(event.kind),
    repo: _safeStr(event.repo, 100),
    file: _safeStr(event.file, 300),
    detail: _safeStr(event.detail, 400),
    source: _safeStr(event.source, 64),
  };
  let q = _writeQueues.get(repoRoot);
  if (!q) { q = { buffer: [], inFlight: [], flushing: false }; _writeQueues.set(repoRoot, q); }
  q.buffer.push(JSON.stringify(record) + '\n');
  _scheduleFlush(repoRoot, file);
  return true;
}

/**
 * Load all events from disk PLUS any records still sitting in the
 * in-memory write queue (so immediate reads after a recordEvent see the
 * just-recorded event even before the async flush completes). Returns an
 * array sorted by ts ascending. Tolerates partial / malformed lines.
 */
function loadEvents(repoRoot, { sinceMs = null, untilMs = null } = {}) {
  const file = sequencesFile(repoRoot);
  const out = [];
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (typeof rec.ts !== 'number') continue;
        if (sinceMs && rec.ts < sinceMs) continue;
        if (untilMs && rec.ts > untilMs) continue;
        out.push(rec);
      } catch (_) { /* skip malformed */ }
    }
  }
  // Also drain anything not yet flushed - both queued AND in-flight, so
  // a synchronous reader immediately after recordEvent never misses a
  // record. Order: in-flight records were pushed before queued ones,
  // and the final sort by ts handles ordering anyway.
  const q = _writeQueues.get(repoRoot);
  if (q) {
    const pending = q.inFlight.concat(q.buffer);
    for (const line of pending) {
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
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Wait for the pending write queue for `repoRoot` to drain. Tests use
 * this to assert deterministically after recordEvent. Production callers
 * never need to wait - reads include the buffer.
 */
function flushPending(repoRoot) {
  return new Promise((resolve) => {
    const isIdle = (q) => !q || (!q.flushing && !q.buffer.length && (!q.inFlight || !q.inFlight.length));
    if (isIdle(_writeQueues.get(repoRoot))) return resolve();
    const check = () => {
      if (isIdle(_writeQueues.get(repoRoot))) return resolve();
      setImmediate(check);
    };
    check();
  });
}

/**
 * Reconstruct sessions from the event stream. A session ends when the next
 * event in the same repo is more than IDLE_GAP_MS later (or when the repo
 * changes). Events with no repo are bucketed under "_unknown".
 *
 * Each session is { repo, startTs, endTs, events: [...] }. Events keep the
 * full record shape so downstream consumers can index by kind/file/detail.
 */
function buildSessions(events, { idleGapMs = IDLE_GAP_MS } = {}) {
  if (!events || !events.length) return [];
  // Group by repo so two simultaneous repos do not collapse into one
  // session. Same-repo continuity is what we care about.
  const byRepo = new Map();
  for (const ev of events) {
    const repo = ev.repo || '_unknown';
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(ev);
  }
  const sessions = [];
  for (const [repo, list] of byRepo.entries()) {
    list.sort((a, b) => a.ts - b.ts);
    let cur = null;
    for (const ev of list) {
      if (!cur || ev.ts - cur.endTs > idleGapMs) {
        cur = { repo, startTs: ev.ts, endTs: ev.ts, events: [ev] };
        sessions.push(cur);
      } else {
        cur.events.push(ev);
        cur.endTs = ev.ts;
      }
    }
  }
  sessions.sort((a, b) => b.startTs - a.startTs); // newest first
  return sessions;
}

/**
 * Convenience: load events from disk and group into sessions in one call.
 */
function getRecentSessions(repoRoot, { days = 30, idleGapMs = IDLE_GAP_MS } = {}) {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = loadEvents(repoRoot, { sinceMs });
  return buildSessions(events, { idleGapMs });
}

/**
 * Prune the on-disk log: drop events older than `olderThanDays`, AND cap
 * total kept lines at `maxLines`. Read-rewrite cycle - cheap up to ~50k
 * lines. Returns { kept, dropped }.
 */
function pruneOld(repoRoot, { olderThanDays = PRUNE_DEFAULT_DAYS, maxLines = MAX_LINES_KEPT } = {}) {
  const file = sequencesFile(repoRoot);
  // Clear the in-memory buffer for this repo - prune is going to fully
  // rewrite the file from a loaded set. If we left buffered lines they
  // would be re-appended after the rewrite, duplicating records. The
  // inFlight slot is allowed to keep its values - those writes are
  // already in-flight to the OS and will land before our rewrite.
  const q = _writeQueues.get(repoRoot);
  if (q) q.buffer = [];
  if (!fs.existsSync(file)) return { kept: 0, dropped: 0 };
  const sinceMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const events = loadEvents(repoRoot, {});
  const kept = events.filter(e => e.ts >= sinceMs).slice(-maxLines);
  const dropped = events.length - kept.length;
  const next = kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : '');
  fs.writeFileSync(file, next, 'utf8');
  return { kept: kept.length, dropped };
}

/**
 * Shape signature for a session: ordered tuple of (kind, simplifiedPath)
 * pairs. Used to cluster similar shapes. Simplified path collapses
 * extensions and trims to the last two segments so "src/components/Hero.tsx"
 * and "src/components/Footer.tsx" both signify "components/<file>".
 *
 * Two sessions with the same signature are very likely the same workflow.
 * Two sessions with overlapping signatures (Jaccard >= 0.5 on kind+segment
 * pairs) are similar enough to cluster together.
 */
function _simplifyPath(p) {
  if (!p) return '';
  const parts = String(p).replace(/\\/g, '/').split('/');
  const tail = parts.slice(-2).join('/');
  return tail.replace(/\.[a-zA-Z0-9]{1,5}$/, '');
}
function shapeSignature(session) {
  if (!session || !session.events) return '';
  return session.events
    .map(e => `${e.kind}:${_simplifyPath(e.file)}`)
    .join('|');
}

function shapeTokens(session) {
  if (!session || !session.events) return new Set();
  const toks = new Set();
  for (const ev of session.events) {
    toks.add(`${ev.kind}:${_simplifyPath(ev.file)}`);
  }
  return toks;
}

function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Cluster sessions by shape similarity. Greedy single-pass: each session
 * either joins the best-matching existing cluster (if Jaccard >= threshold)
 * or starts a new cluster. Returns clusters sorted by size descending.
 *
 * Each cluster: { id, sessions: [...], anchorTokens, count }.
 */
function clusterSessions(sessions, { threshold = 0.5, minClusterSize = 3, minSessionEvents = 3 } = {}) {
  const eligible = (sessions || []).filter(s => s && s.events && s.events.length >= minSessionEvents);
  const clusters = [];
  for (const s of eligible) {
    const toks = shapeTokens(s);
    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      const score = _jaccard(toks, c.anchorTokens);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best && bestScore >= threshold) {
      best.sessions.push(s);
      // Anchor tokens widen toward the union; clip if it grows too large.
      for (const t of toks) best.anchorTokens.add(t);
      best.count = best.sessions.length;
    } else {
      clusters.push({
        id: 'cluster_' + Math.random().toString(36).slice(2, 8),
        sessions: [s],
        anchorTokens: new Set(toks),
        count: 1,
      });
    }
  }
  return clusters
    .filter(c => c.count >= minClusterSize)
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  IDLE_GAP_MS,
  sequencesFile,
  recordEvent,
  loadEvents,
  buildSessions,
  getRecentSessions,
  pruneOld,
  shapeSignature,
  shapeTokens,
  clusterSessions,
  flushPending,
};
