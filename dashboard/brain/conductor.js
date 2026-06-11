/**
 * The conductor - Stage 4 routing intelligence (substrate version).
 *
 * The plan wanted the conductor fed by the activation kernel's convergence
 * signal ("clean settle = recall, oscillation = escalate"). The kernel is a
 * NO-GO, so the conductor is grounded instead in the signals that DO exist and
 * are already logged:
 *   - the planner's triage confidence + recall-vs-escalate classification
 *   - the durable route-log (Stage 0) - recent escalation behaviour
 *   - outcome stats (Stage 0) - which rung/CLI historically works per intent
 *   - whether Mind can ground a recall (Stage 0 retrieval + Stage 3 thinking)
 *
 * It formalizes the 3-rung ladder and, per locked decision #3, ADVISES - it
 * never gates. The frontier actor (a CLI like Claude/Codex) reads the
 * recommendation and may override; a wrong advisory rung is recoverable.
 * Pure + deterministic so every routing decision is replayable.
 */

'use strict';

const planner = require('./planner');
const answer = require('./answer');

// The 3-rung ladder. rung1/2 are local (free); rung3 summons a frontier CLI.
const LADDER = {
  1: { id: 'triage-recall', tier: 'local', model: planner.TRIAGE_MODEL, role: 'classify + answer from Mind', cost: 'trivial' },
  2: { id: 'local-reason', tier: 'local', model: planner.REASONING_MODEL, role: 'local reasoning, no tools', cost: 'local-compute' },
  3: { id: 'frontier', tier: 'frontier', model: 'cli', role: 'tools, code, heavy reasoning', cost: 'frontier-tokens' },
};

/**
 * Recommend a rung for a planned input. ADVISORY.
 *
 * @param plan     a planner.planRoute() result
 * @param signals  optional grounding: {
 *                   mindCanGround?: boolean,   // Stage 0/3: can Mind answer it?
 *                   bestCliFor?: { cli, validatedRate, n } | null, // outcomes
 *                   recentEscalationRate?: number, // route-log stats
 *                 }
 * @returns { rung: 1|2|3, reason, confidence, advisory: true, ladder }
 */
function recommendRung(plan, signals = {}) {
  const decision = (plan && plan.decision) || {};
  const intent = decision.intent || 'ambiguous';
  const conf = typeof plan.triageConfidence === 'number'
    ? plan.triageConfidence
    : (typeof decision.confidence === 'number' ? decision.confidence : 0);

  const out = (rung, reason, confidence) => ({
    rung, reason, confidence: Math.round(confidence * 1000) / 1000,
    advisory: true, intent, triageConfidence: conf, rungInfo: LADDER[rung],
  });

  // Tool-bound intents -> rung 3. The brain refuses to fake code/plan/app/
  // browser/plugin work locally (mirrors answer.ALWAYS_ESCALATE +
  // planner.INTENTS_REQUIRING_CLI).
  if (answer.ALWAYS_ESCALATE.has(intent) || planner.INTENTS_REQUIRING_CLI.has(intent)) {
    return out(3, `intent "${intent}" needs tools/code; summon a frontier CLI`, 0.9);
  }

  // Greeting / acknowledgement: rung 1, no reasoning.
  if (intent === 'greeting') return out(1, 'greeting; acknowledge, no model needed', 0.95);

  // Recall: rung 1 if Mind can ground it; otherwise rung 3 (frontier can search
  // the codebase + git history where local memory came up empty).
  if (intent === 'recall') {
    if (signals.mindCanGround === false) {
      return out(3, 'recall but Mind cannot ground it; frontier can search beyond memory', 0.7);
    }
    return out(1, 'recall answerable from Mind', Math.max(conf, 0.6));
  }

  // The planner already escalated triage -> reasoning. Honor rung 2 unless
  // outcome history says local reasoning keeps failing this intent, in which
  // case advise rung 3.
  if (plan.escalated) {
    if (signals.bestCliFor && signals.bestCliFor.cli && signals.bestCliFor.validatedRate >= 0.6) {
      return out(3, `escalated; outcomes favour ${signals.bestCliFor.cli} (${Math.round(signals.bestCliFor.validatedRate * 100)}%) on ${intent}`, 0.75);
    }
    return out(2, 'triage escalated to local reasoning', Math.max(conf, 0.5));
  }

  // Confident, non-tool triage stays at rung 1.
  if (conf >= planner.ESCALATION_THRESHOLD) return out(1, 'confident triage; answer locally', conf);

  // Low confidence, no tool need -> rung 2 local reasoning before spending
  // frontier tokens.
  return out(2, 'low triage confidence; try local reasoning before frontier', Math.max(conf, 0.4));
}

module.exports = { recommendRung, LADDER };
