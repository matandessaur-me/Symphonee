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

/**
 * Record a single event. Writes one JSONL line. Cheap (millisecond-scale
 * synchronous file append). If the write fails we swallow - sequence
 * recording must never block the calling code path.
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
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Load all events from disk. Returns an array sorted by ts ascending.
 * Tolerates partial / malformed lines (skips them). For a 50k-line file
 * this is tens of milliseconds on disk plus a single JSON.parse per line.
 */
function loadEvents(repoRoot, { sinceMs = null, untilMs = null } = {}) {
  const file = sequencesFile(repoRoot);
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
    } catch (_) { /* skip malformed */ }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
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
};
