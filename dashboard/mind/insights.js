/**
 * Insights - Mind's proactive surface.
 *
 * Distinct from memory cards (durable knowledge). An insight is a
 * SUGGESTED ACTION the user can take or ignore. Mind notices something
 * about its own corpus (you've asked X three times, these files always
 * change together, this card hasn't been recalled in 3 months) and
 * proposes a follow-up.
 *
 * Each insight is a graph node kind:insight with:
 *   category    repeated-question | co-edit | memory-decay | cross-repo
 *   label       short title (under 200 chars)
 *   body        explanation (under 4000 chars)
 *   action      { type, payload } - executed when the user clicks Act
 *   status      pending | acted | dismissed | snoozed
 *   snoozedUntil ISO timestamp (only set when status:snoozed)
 *   signature   stable hash of category + sorted evidence ids; dedup key
 *   evidence    nodeIds the insight was derived from
 *
 * The signature lets analysers re-run safely - they emit candidates,
 * we dedup by signature so we never resurrect a dismissed insight or
 * duplicate a still-pending one. Snoozed insights wake up automatically
 * when status === 'snoozed' && now > snoozedUntil (callers check via
 * listInsights filter).
 */

'use strict';

const crypto = require('crypto');
const store = require('./store');
const lock = require('./lock');
const { sanitizeLabel } = require('./security');

const VALID_CATEGORIES = new Set(['repeated-question', 'co-edit', 'memory-decay', 'cross-repo', 'memory-staleness', 'memory-contradiction']);
const VALID_ACTION_TYPES = new Set(['create-memory', 'create-recipe', 'archive-memories', 'extract-shared', 'supersede-memory']);
const VALID_STATUSES = new Set(['pending', 'acted', 'dismissed', 'snoozed']);
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function _genId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `insight_${t}_${r}`;
}

function _signature(category, evidence) {
  const sorted = (evidence || []).slice().sort().join('|');
  return crypto.createHash('sha1').update(`${category}::${sorted}`).digest('hex').slice(0, 16);
}

function _validate(spec) {
  if (!spec || typeof spec !== 'object') return 'spec must be an object';
  if (!VALID_CATEGORIES.has(spec.category)) return `category must be one of ${[...VALID_CATEGORIES].join(', ')}`;
  if (!spec.title || typeof spec.title !== 'string') return 'title required';
  if (!spec.body || typeof spec.body !== 'string') return 'body required';
  if (!spec.action || typeof spec.action !== 'object') return 'action required';
  if (!VALID_ACTION_TYPES.has(spec.action.type)) return `action.type must be one of ${[...VALID_ACTION_TYPES].join(', ')}`;
  if (!Array.isArray(spec.evidence) || spec.evidence.length === 0) return 'evidence (non-empty array of node ids) required';
  return null;
}

function _findBySignature(graph, signature) {
  return (graph.nodes || []).find(n => n.kind === 'insight' && n.signature === signature);
}

/**
 * List insights, optionally filtered by status. Snoozed insights whose
 * snoozedUntil has passed are returned as 'pending' so the UI shows
 * them again. The status field on the persisted node still says
 * 'snoozed' until a write happens — callers acting on a woken insight
 * implicitly transition it.
 */
function listInsights({ repoRoot, space, status = 'pending' } = {}) {
  const g = store.loadGraph(repoRoot, space);
  if (!g) return [];
  const now = Date.now();
  return (g.nodes || [])
    .filter(n => n.kind === 'insight')
    .map(n => {
      if (n.status === 'snoozed' && n.snoozedUntil && Date.parse(n.snoozedUntil) <= now) {
        return { ...n, status: 'pending', _wokenFromSnooze: true };
      }
      return n;
    })
    .filter(n => status === 'all' ? true : n.status === status)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function countPending({ repoRoot, space } = {}) {
  return listInsights({ repoRoot, space, status: 'pending' }).length;
}

/**
 * Idempotent insert. If an insight with the same (category, evidence)
 * signature already exists, return it without modifying status — that
 * way analysers can re-fire without resurrecting dismissed insights or
 * duplicating still-pending ones.
 */
async function addInsight({ repoRoot, space, spec }) {
  const err = _validate(spec);
  if (err) throw new Error(err);
  const acq = lock.acquire(space, 'graph');
  if (!acq.ok) {
    const e = new Error(`mind graph operation already running (pid ${acq.holderPid || 'unknown'})`);
    e.code = 'MIND_LOCKED';
    throw e;
  }
  try {
    const g = store.loadGraph(repoRoot, space) || {
      version: 1, scope: { space, isGlobal: false }, nodes: [], edges: [],
    };
    const signature = _signature(spec.category, spec.evidence);
    const existing = _findBySignature(g, signature);
    if (existing) {
      // If the existing insight is dismissed, we respect that — silent
      // re-fire from a re-running analyser must not undo a user choice.
      // If it's snoozed but the snooze has expired, the user sees it
      // again naturally via listInsights without us touching the node.
      return { node: existing, deduped: true };
    }
    const createdAt = new Date().toISOString();
    const id = _genId();
    const node = {
      id,
      kind: 'insight',
      category: spec.category,
      label: sanitizeLabel(spec.title.slice(0, 200)),
      body: sanitizeLabel(spec.body.slice(0, 4000)),
      action: spec.action,
      status: 'pending',
      signature,
      evidence: spec.evidence,
      createdBy: spec.createdBy || 'mind/insights',
      createdAt,
      updatedAt: createdAt,
    };
    g.nodes.push(node);
    store.saveGraph(repoRoot, space, g);
    return { node, deduped: false };
  } finally {
    lock.release(space, 'graph');
  }
}

async function _updateStatus({ repoRoot, space, id, patch }) {
  const acq = lock.acquire(space, 'graph');
  if (!acq.ok) {
    const e = new Error('mind graph busy');
    e.code = 'MIND_LOCKED';
    throw e;
  }
  try {
    const g = store.loadGraph(repoRoot, space);
    if (!g) throw new Error('no graph');
    const idx = g.nodes.findIndex(n => n.id === id && n.kind === 'insight');
    if (idx === -1) throw new Error('insight not found');
    const updated = { ...g.nodes[idx], ...patch, updatedAt: new Date().toISOString() };
    if (!VALID_STATUSES.has(updated.status)) throw new Error('invalid status');
    g.nodes[idx] = updated;
    store.saveGraph(repoRoot, space, g);
    return updated;
  } finally {
    lock.release(space, 'graph');
  }
}

function dismissInsight({ repoRoot, space, id }) {
  return _updateStatus({ repoRoot, space, id, patch: { status: 'dismissed', snoozedUntil: null } });
}

function snoozeInsight({ repoRoot, space, id, durationMs = SNOOZE_MS }) {
  const until = new Date(Date.now() + durationMs).toISOString();
  return _updateStatus({ repoRoot, space, id, patch: { status: 'snoozed', snoozedUntil: until } });
}

function markActed({ repoRoot, space, id, result }) {
  return _updateStatus({ repoRoot, space, id, patch: { status: 'acted', snoozedUntil: null, actedResult: result || null } });
}

module.exports = {
  addInsight,
  listInsights,
  countPending,
  dismissInsight,
  snoozeInsight,
  markActed,
  VALID_CATEGORIES,
  VALID_ACTION_TYPES,
  VALID_STATUSES,
  SNOOZE_MS,
};
