/**
 * Contradiction + supersession detection - the substrate-grounded core of
 * Stage 3 ("make it think").
 *
 * The plan's Stage 3 wanted inhibitory synapses on the activation kernel:
 * supersede/contradict edges that let the brain notice when its own memories
 * disagree and prefer the live one over the stale one. The activation kernel is
 * a NO-GO, but the GOAL - don't confidently recall a fact that a newer memory
 * has already overturned - is achievable directly over the memory graph, with
 * no kernel and no LLM. That is what this module does.
 *
 * Two relations, both deterministic:
 *   supersession - a NEWER memory card explicitly overturns an older one
 *                  ("X is now superseded by Y", "no longer", "now prefer",
 *                  "use Y not X"). The older card goes DORMANT.
 *   conflict     - two cards on the same topic with OPPOSITE polarity
 *                  (one "always/use/prefer X", the other "never/avoid/don't X")
 *                  with no clear time order. Surfaced as uncertainty, not
 *                  silently resolved.
 *
 * "Thinking" here = recall that down-ranks dormant memory and flags genuine
 * conflicts as uncertain instead of picking one at random.
 *
 * What is NOT here (honestly kernel-gated): bounded Hebbian/STDP plasticity (C)
 * and sleep/consolidation (D). Those were defined as deltas ON the activation
 * kernel; with the kernel killed they have no substrate. Deferred, not faked.
 */

'use strict';

const STOPWORDS = new Set(('a an the is are was were be been being of to in on for and or but not no with without ' +
  'this that these those it its do does did use used using prefer always never avoid dont don t should must can ' +
  'we you i they he she them our your my x y z via over under into out up down off so as at by from now new old').split(/\s+/));

const SUPERSEDE_RE = /\b(supersed(?:e|es|ed|ing)|no longer|replaced by|deprecat\w*|out[- ]of[- ]date|instead of|now (?:use|prefer|do)|use .+ not |overrid\w+|obsolet\w*)\b/i;
const POS_POLARITY = /\b(always|use|prefer|do|enable|keep|should|must)\b/i;
const NEG_POLARITY = /\b(never|avoid|don't|dont|do not|disable|stop|remove|should not|must not|no longer)\b/i;

const MIN_SHARED_TOKENS = 2;

function _text(n) {
  return [n.label || '', n.body || '', n.summary || ''].join(' ');
}
function _tokens(s) {
  const out = new Set();
  for (const raw of String(s).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}
function _shared(aTokens, bTokens) {
  let n = 0;
  for (const t of aTokens) if (bTokens.has(t)) n++;
  return n;
}
function _time(n) {
  const t = Date.parse(n.createdAt || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Analyze the graph's memory cards for supersessions + conflicts.
 * @returns {
 *   supersessions: [{ superseder, superseded, shared, evidence }],
 *   conflicts:     [{ a, b, shared }],
 *   dormantIds:    string[]   // superseded card ids - recall should down-rank
 * }
 */
function analyze(graph) {
  const memories = (graph && graph.nodes ? graph.nodes : []).filter(n => n.kind === 'memory');
  const toks = new Map();
  for (const m of memories) toks.set(m.id, _tokens(_text(m)));

  const supersessions = [];
  const dormant = new Set();
  // Supersession: a card with supersede language overturns an OLDER card that
  // shares enough topic tokens.
  for (const m of memories) {
    if (!SUPERSEDE_RE.test(_text(m))) continue;
    const mTok = toks.get(m.id);
    const mTime = _time(m);
    let best = null;
    for (const other of memories) {
      if (other.id === m.id) continue;
      if (_time(other) > mTime) continue; // only overturn OLDER cards
      const shared = _shared(mTok, toks.get(other.id));
      if (shared >= MIN_SHARED_TOKENS && (!best || shared > best.shared)) {
        best = { superseded: other.id, shared };
      }
    }
    if (best) {
      const ev = (m.body || m.label || '').match(SUPERSEDE_RE);
      supersessions.push({ superseder: m.id, superseded: best.superseded, shared: best.shared, evidence: ev ? ev[0] : null });
      dormant.add(best.superseded);
    }
  }

  // Conflict: opposite polarity on a shared topic, no supersession between them.
  const conflicts = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i], b = memories[j];
      if (dormant.has(a.id) || dormant.has(b.id)) continue;
      const shared = _shared(toks.get(a.id), toks.get(b.id));
      if (shared < MIN_SHARED_TOKENS) continue;
      const at = _text(a), bt = _text(b);
      const aPos = POS_POLARITY.test(at), aNeg = NEG_POLARITY.test(at);
      const bPos = POS_POLARITY.test(bt), bNeg = NEG_POLARITY.test(bt);
      if ((aPos && bNeg && !aNeg) || (aNeg && bPos && !bNeg)) {
        conflicts.push({ a: a.id, b: b.id, shared });
      }
    }
  }

  return { supersessions, conflicts, dormantIds: [...dormant] };
}

/**
 * Annotate recall hits with the analysis: mark dormant (superseded) memory
 * hits and flag those involved in an unresolved conflict. Pure; returns a new
 * array. Callers can down-rank dormant hits and surface conflict as uncertainty.
 */
function annotate(hits, analysis) {
  const dormant = new Set(analysis.dormantIds);
  const conflicted = new Set();
  for (const c of analysis.conflicts) { conflicted.add(c.a); conflicted.add(c.b); }
  return hits.map(h => ({
    ...h,
    superseded: dormant.has(h.id) || false,
    contradicted: conflicted.has(h.id) || false,
  }));
}

module.exports = { analyze, annotate, SUPERSEDE_RE, MIN_SHARED_TOKENS };
