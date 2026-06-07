/**
 * Memory contradiction analyser.
 *
 * Finds memory cards that cover the SAME topic and either (a) assert opposing
 * things (a real contradiction) or (b) look like one supersedes the other (two
 * decisions on the same topic, taken at different times). Left unmanaged, the
 * brain holds both "prefer X" and "prefer Y" about the same thing and recall
 * returns whichever ranks higher -- the user can't tell which is current.
 *
 * Precision over recall (a false "these conflict" erodes trust): we only pair
 * ASSERTIVE cards (decision / preference / constraint), require STRONG topical
 * overlap (>= 2 shared meaningful tags, or same repo-scope + >= 2 shared), and
 * only then look for opposing polarity or a supersede pattern. Findings surface
 * as ONE insight with the reversible supersede-memory action (archive the older
 * card, link newer -> older). The user confirms; nothing is auto-changed.
 */

'use strict';

const store = require('../store');

const ASSERTIVE = new Set(['decision', 'preference', 'constraint']);
const MAX_PAIRS = 8;
const DAY = 24 * 60 * 60 * 1000;
// Tags too generic to establish a shared topic.
const STOP_TAGS = new Set(['memory', 'decision', 'preference', 'constraint', 'lesson', 'gotcha', 'pattern', 'fact', 'note', 'general', 'misc', 'todo']);
const POS_RE = /\b(use|prefer|always|enable|adopt|chose|choose|chosen|should|go with|switch to|standardi[sz]e on)\b/i;
const NEG_RE = /\b(don't|do not|never|avoid|disable|drop|dropped|deprecate|deprecated|instead of|not use|stop using|move away|migrate away|remove)\b/i;

function _meaningfulTags(card) {
  return (Array.isArray(card.tags) ? card.tags : [])
    .map((t) => String(t).toLowerCase().trim())
    .filter((t) => t && t.length > 1 && !STOP_TAGS.has(t));
}
function _sharedCount(a, b) {
  const sb = new Set(b);
  let n = 0;
  for (const t of a) if (sb.has(t)) n++;
  return n;
}
function _ts(card) { const t = Date.parse(card.createdAt || ''); return Number.isNaN(t) ? 0 : t; }
function _polarity(card) {
  const text = String(card.body || '') + ' ' + String(card.label || '');
  // Negation dominates: "never use X" / "don't use X" / "stop using X" all
  // contain an affirmative verb ("use") but are clearly negative directives.
  if (NEG_RE.test(text)) return 'neg';
  if (POS_RE.test(text)) return 'pos';
  return 'mixed';
}

function scan({ repoRoot, space } = {}) {
  const g = store.loadGraph(repoRoot, space);
  if (!g) return { pairs: [] };
  const cards = (g.nodes || [])
    .filter((n) => n.kind === 'memory' && n.status !== 'archived' && ASSERTIVE.has(n.kindOfMemory))
    .map((n) => ({ node: n, tags: _meaningfulTags(n), repo: n.scope && n.scope.repo }));

  const pairs = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j];
      const shared = _sharedCount(a.tags, b.tags);
      const sameRepo = a.repo && b.repo && a.repo === b.repo;
      // Strong topical overlap gate.
      if (!(shared >= 2 || (sameRepo && shared >= 1 && (a.tags.length + b.tags.length) >= 3))) continue;

      const pa = _polarity(a.node), pb = _polarity(b.node);
      const opposing = (pa === 'pos' && pb === 'neg') || (pa === 'neg' && pb === 'pos');
      const bothDecisions = a.node.kindOfMemory === 'decision' && b.node.kindOfMemory === 'decision';
      const gap = Math.abs(_ts(a.node) - _ts(b.node));

      let reason = null;
      if (opposing) reason = 'conflict';
      else if (bothDecisions && gap > DAY) reason = 'superseded';
      if (!reason) continue;

      const older = _ts(a.node) <= _ts(b.node) ? a.node : b.node;
      const newer = older === a.node ? b.node : a.node;
      pairs.push({
        older: older.id, newer: newer.id,
        olderLabel: older.label || '', newerLabel: newer.label || '',
        reason, shared,
      });
    }
  }
  // De-dup: keep the first pairing that involves a given older card.
  const seen = new Set();
  const deduped = pairs.filter((p) => { if (seen.has(p.older)) return false; seen.add(p.older); return true; });
  return { pairs: deduped };
}

function detect(deps = {}) {
  const { pairs } = scan(deps);
  if (!pairs.length) return [];
  const batch = pairs.slice(0, MAX_PAIRS);
  const conflicts = batch.filter((p) => p.reason === 'conflict').length;
  const body = [
    `${pairs.length} pair${pairs.length === 1 ? '' : 's'} of memory cards cover the same topic and look ${conflicts ? 'contradictory or ' : ''}redundant.`,
    '',
    ...batch.map((p) => `  - [${p.reason}] "${p.olderLabel.slice(0, 60)}"  vs  "${p.newerLabel.slice(0, 60)}"`),
    pairs.length > MAX_PAIRS ? `  ... and ${pairs.length - MAX_PAIRS} more` : '',
    '',
    'Supersede archives the older card and links the newer one to it (reversible). Or edit a card to resolve the conflict yourself.',
  ].filter(Boolean).join('\n');
  return [{
    category: 'memory-contradiction',
    title: `${pairs.length} memory pair${pairs.length === 1 ? '' : 's'} ${conflicts ? 'may conflict' : 'look redundant'} -- resolve?`,
    body,
    action: { type: 'supersede-memory', payload: { pairs: batch.map((p) => ({ older: p.older, newer: p.newer })) } },
    evidence: batch.flatMap((p) => [p.older, p.newer]),
  }];
}

module.exports = { detect, scan };
