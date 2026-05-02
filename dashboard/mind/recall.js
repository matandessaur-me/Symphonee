/**
 * Recall: time-ranged + topic-filtered retrieval over the parts of Mind
 * that actually carry knowledge across sessions.
 *
 * Answers questions like:
 *   - "what did I figure out about Stagehand last month?"
 *   - "what was that thing you told me 10 days ago?"
 *   - "what do I know about Playdate development?"
 *
 * Different from /api/mind/query (BFS sub-graph for a question) in two
 * ways:
 *   1. Time is a first-class filter. Pass `since` / `until` as ISO dates
 *      or natural-language strings ("10 days ago", "last week",
 *      "yesterday"). The corpus is restricted to nodes whose createdAt
 *      falls in the window.
 *   2. Output is a ranked LIST of items, not a sub-graph. The caller
 *      reads each item top-down without traversal. That's the right
 *      shape when the user is asking "what do I remember", not "how is
 *      X connected".
 *
 * Three node kinds are recall-eligible: memory cards (highest priority),
 * conversation nodes (Q&A transcripts), and drawer nodes (verbatim CLI
 * turns - noisier, ranked last). Other kinds (code, doc, plugin, ...)
 * are graph topology, not memory; they don't appear in recall results.
 */

'use strict';

const { bm25Scores } = require('./bm25');

// Order matters: memories first, conversations second, drawers third.
const RECALL_KINDS = ['memory', 'conversation', 'drawer'];

const KIND_BASE_SCORE = {
  memory: 5.0,
  conversation: 1.5,
  drawer: 0.6,
};

const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * Parse a date filter as either:
 *   - null/undefined           -> null (no filter)
 *   - Date | ISO timestamp     -> the parsed Date
 *   - "<N> days ago"           -> Date offset from now
 *   - "yesterday" / "today"    -> Date offset from now
 *   - "last week" / "last month" -> Date offset from now
 *
 * Returns Date | null. Throws on a string that looks like a date hint
 * but parses to nothing - silently dropping malformed input would
 * silently change the answer set.
 */
function parseDateHint(hint, now = new Date()) {
  if (hint == null) return null;
  if (hint instanceof Date) return Number.isNaN(hint.getTime()) ? null : hint;
  if (typeof hint !== 'string') return null;
  const trimmed = hint.trim();
  if (!trimmed) return null;

  // Direct ISO / parseable string
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) return direct;

  const lower = trimmed.toLowerCase();
  if (lower === 'today')     return new Date(now.getTime());
  if (lower === 'yesterday') return new Date(now.getTime() - DAY_MS);
  if (lower === 'last week') return new Date(now.getTime() - 7 * DAY_MS);
  if (lower === 'last month') return new Date(now.getTime() - 30 * DAY_MS);
  if (lower === 'last year')  return new Date(now.getTime() - 365 * DAY_MS);

  // "<N> <unit> ago" patterns
  const m = lower.match(/^(\d+)\s+(day|days|week|weeks|month|months|year|years|hour|hours)\s+ago$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    let ms = 0;
    if (unit.startsWith('hour')) ms = n * 60 * 60 * 1000;
    else if (unit.startsWith('day'))   ms = n * DAY_MS;
    else if (unit.startsWith('week'))  ms = n * 7 * DAY_MS;
    else if (unit.startsWith('month')) ms = n * 30 * DAY_MS;
    else if (unit.startsWith('year'))  ms = n * 365 * DAY_MS;
    return new Date(now.getTime() - ms);
  }

  throw new Error(`recall: could not parse date hint "${hint}"`);
}

function _searchableText(n) {
  const parts = [n.label || ''];
  if (typeof n.body === 'string')   parts.push(n.body);
  if (typeof n.answer === 'string') parts.push(n.answer);
  if (typeof n.content === 'string')parts.push(n.content);
  if (Array.isArray(n.tags))        parts.push(n.tags.join(' '));
  if (typeof n.summary === 'string')parts.push(n.summary);
  return parts.join(' ');
}

function _matchesRepo(n, repoSlug) {
  if (!repoSlug) return true;
  if (n.scope && typeof n.scope.repo === 'string') {
    const s = n.scope.repo.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase();
    if (s === repoSlug) return true;
  }
  if (Array.isArray(n.tags)) {
    for (const t of n.tags) {
      if (typeof t !== 'string') continue;
      const ct = t.toLowerCase().replace(/[\s_.\-]+/g, '');
      const cr = repoSlug.replace(/_/g, '');
      if (cr && ct === cr) return true;
    }
  }
  // cwd:<slug> tag form some extractors emit
  if (Array.isArray(n.tags) && n.tags.includes(`cwd:${repoSlug}`)) return true;
  return false;
}

/**
 * Recall over the graph.
 *
 * @param graph    Mind graph object.
 * @param opts.question Optional natural-language query for BM25 ranking.
 *                  Skipped (kind-base scoring only) when omitted.
 * @param opts.since    Lower bound on createdAt (Date | string | null).
 * @param opts.until    Upper bound on createdAt (Date | string | null).
 * @param opts.repo     Repo name to scope the recall to. Matches
 *                      memory.scope.repo, cwd_<slug> tags, or canonical
 *                      tag string.
 * @param opts.kinds    Restrict to a subset of RECALL_KINDS. Default all.
 * @param opts.limit    Max items returned. Default 20, hard cap 200.
 *
 * @returns {{ hits, total, since, until, repo, question }}
 *   hits: ranked array of { id, kind, label, kindOfMemory?, createdAt,
 *                           score, ageDays, snippet }
 */
function recall(graph, opts = {}) {
  const out = {
    hits: [],
    total: 0,
    since: null,
    until: null,
    repo: opts.repo || null,
    question: opts.question || '',
  };
  if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) return out;

  const since = parseDateHint(opts.since);
  const until = parseDateHint(opts.until);
  out.since = since ? since.toISOString() : null;
  out.until = until ? until.toISOString() : null;

  const allowedKinds = new Set(
    Array.isArray(opts.kinds) && opts.kinds.length
      ? opts.kinds.filter(k => RECALL_KINDS.includes(k))
      : RECALL_KINDS,
  );
  const repoSlug = opts.repo
    ? String(opts.repo).replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase()
    : null;

  // Filter to recall-eligible nodes within the date window and repo scope.
  const candidates = [];
  for (const n of graph.nodes) {
    if (!allowedKinds.has(n.kind)) continue;
    if (!_matchesRepo(n, repoSlug)) continue;
    const ts = Date.parse(n.createdAt || '');
    if (!Number.isNaN(ts)) {
      if (since && ts < since.getTime()) continue;
      if (until && ts > until.getTime()) continue;
    } else if (since || until) {
      // Node has no usable timestamp but caller requested a window.
      // Skip - we cannot prove it falls inside.
      continue;
    }
    candidates.push(n);
  }
  out.total = candidates.length;
  if (!candidates.length) return out;

  // BM25 over (label + body + answer + content + tags) when a question
  // is supplied, otherwise score by kind-base + recency only.
  let bmScores = null;
  if (opts.question && typeof opts.question === 'string' && opts.question.trim()) {
    const docs = candidates.map(_searchableText);
    bmScores = bm25Scores(opts.question, docs);
  }

  // When a question is supplied, weight BM25 high enough that a strong
  // topic match outranks a fresh-but-irrelevant card. With no question,
  // base + recency carries the ranking and "what did I do recently"
  // returns sensible results.
  const BM25_WEIGHT = bmScores ? 4.0 : 0;

  const now = Date.now();
  const scored = candidates.map((n, i) => {
    const base = KIND_BASE_SCORE[n.kind] || 0.5;
    let score = base;
    if (bmScores) score += BM25_WEIGHT * (bmScores[i] || 0);
    const ts = Date.parse(n.createdAt || '');
    let ageDays = null;
    if (!Number.isNaN(ts)) {
      ageDays = Math.max(0, (now - ts) / DAY_MS);
      // Smooth recency boost: full bonus today, decays over ~60 days.
      // Smaller when a question is supplied (topic match should win).
      const recencyW = bmScores ? 0.7 : 1.5;
      score += recencyW * Math.exp(-ageDays / 30);
    }
    // Memories that have been recalled before are more valuable.
    if (n.kind === 'memory' && Array.isArray(n.referencedAt)) {
      score += Math.min(1, n.referencedAt.length * 0.2);
    }
    const snippetSrc = n.body || n.answer || n.content || n.summary || n.label || '';
    const snippet = String(snippetSrc).replace(/\s+/g, ' ').trim().slice(0, 240);
    return {
      id: n.id,
      kind: n.kind,
      label: n.label,
      kindOfMemory: n.kindOfMemory || null,
      createdAt: n.createdAt || null,
      ageDays: ageDays != null ? Math.round(ageDays * 10) / 10 : null,
      score: Math.round(score * 1000) / 1000,
      snippet,
      tags: Array.isArray(n.tags) ? n.tags : [],
    };
  });
  scored.sort((a, b) => b.score - a.score || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const limit = Math.max(1, Math.min(200, opts.limit || 20));
  out.hits = scored.slice(0, limit);
  return out;
}

module.exports = {
  recall,
  parseDateHint,
  RECALL_KINDS,
  KIND_BASE_SCORE,
};
