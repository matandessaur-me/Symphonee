/**
 * The voice - Stage 5's front-door answering, ARIA-corrected.
 *
 * The ARIA lesson (locked decision #2): NEVER let the local model be the voice -
 * that is why it felt robotic. So the local path here produces NO local prose.
 * For factual recall it fills polished DETERMINISTIC TEMPLATES from the graph
 * (Stage 0 retrieval + Stage 3 contradiction-awareness); for anything that
 * needs real naturalness or reasoning it returns escalate:true so a FRONTIER
 * model speaks. Templated-when-trivial, frontier-when-it-matters.
 *
 * Pure: takes recall hits + a resolved persona surface, returns a templated
 * answer or an escalate signal. The route wiring (load graph, recall, dispatch)
 * lives in brain/index.js.
 */

'use strict';

function _cap(s) {
  const t = String(s || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * Build a deterministic templated answer from recall hits, honouring the
 * persona surface (ids/paths visibility, item count, verbosity).
 *
 * @returns {
 *   grounded: boolean,
 *   answer: string|null,
 *   citedNodeIds: string[],
 *   uncertain: boolean,    // true when memory conflicts
 *   templated: true,
 *   reason?: string        // when not grounded
 * }
 */
function templatedRecall(question, hits, surface = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const live = list.filter(h => !h.superseded);
  if (!live.length) {
    return { grounded: false, answer: null, citedNodeIds: [], uncertain: false, templated: true, reason: 'no-live-memory' };
  }
  const showIds = surface.showIds !== false;
  const maxItems = surface.maxItems || 3;
  const cite = (h) => (showIds && h.id ? ` [${h.id}]` : '');

  const top = live[0];
  const parts = [`${_cap(top.snippet || top.label || '')}${cite(top)}`];

  const more = live.slice(1, maxItems);
  if (more.length && surface.verbosity !== 'summary') {
    parts.push('', 'Also relevant:');
    for (const h of more) parts.push(`- ${h.snippet || h.label}${cite(h)}`);
  }

  const uncertain = list.some(h => h.contradicted);
  if (uncertain) {
    parts.push('', 'Note: I hold conflicting memories on this; treat it as uncertain.');
  }

  return {
    grounded: true,
    answer: parts.join('\n'),
    citedNodeIds: live.slice(0, maxItems).map(h => h.id),
    uncertain,
    templated: true,
  };
}

/**
 * Decide the front-door outcome from the conductor recommendation + a templated
 * recall attempt. Local templated answer when grounded at rung 1; otherwise an
 * escalate signal carrying the rung recommendation for the frontier voice.
 *
 * @returns { source: 'templated'|'escalate', answer?, citedNodeIds?, uncertain?, rung, reason }
 */
function frontDoor({ recommendation, recall, question, surface }) {
  const rung = recommendation ? recommendation.rung : 2;
  // Only the trivia/recall path is answered locally - and only via templates.
  if (rung === 1 && recommendation.intent === 'recall' && recall) {
    const t = templatedRecall(question, recall.hits || [], surface);
    if (t.grounded) {
      return { source: 'templated', answer: t.answer, citedNodeIds: t.citedNodeIds, uncertain: t.uncertain, rung: 1, reason: 'grounded templated recall' };
    }
  }
  return {
    source: 'escalate',
    rung,
    reason: recommendation ? recommendation.reason : 'needs the frontier voice',
    recommendation,
  };
}

module.exports = { templatedRecall, frontDoor };
