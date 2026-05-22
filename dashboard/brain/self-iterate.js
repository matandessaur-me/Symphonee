/**
 * Self-iteration on planner rules - the brain edits its own brain.
 *
 * Reads the outcome stats + recent audit log, detects systematic failure
 * patterns (e.g. "intent=X consistently routed to CLI=Y but gets
 * corrected to CLI=Z"), feeds the failure summary + the current rules
 * block to gemma, and asks for a proposed revision.
 *
 * The proposal is NEVER auto-applied. The flow is:
 *   1. POST /api/symphonee/self-iterate -> returns { proposal, diff }
 *   2. User reviews
 *   3. POST /api/symphonee/self-iterate/accept -> writes the new rules
 *      (prompt-store records the previous version in history for revert)
 *
 * Safety:
 *   - The structural framing (output schema, JSON contract) is hard-coded
 *     in planner.js and not editable here. Only the routing-rules text.
 *   - The proposal includes the verbatim current rules so the user can
 *     see exactly what changes.
 *   - Reverts are one POST away.
 *   - When sample data is thin (< MIN_SAMPLES_FOR_ITERATION), we refuse
 *     to propose. Avoids self-modifying on noise.
 */

'use strict';

const llm = require('../mind/llm');
const outcomes = require('./outcomes');
const promptStore = require('./prompt-store');

const MIN_SAMPLES_FOR_ITERATION = 15;  // need enough outcomes to detect a real pattern
const REASONING_MODEL = process.env.SYMPHONEE_REASONING_MODEL || 'gemma4:26b';
const ITERATION_TIMEOUT_MS = 120_000;

/**
 * Scan the outcome stats and emit a list of human-readable failure
 * descriptions the model can reason about. Returns [] when no clear
 * pattern emerges.
 */
function _detectFailurePatterns(stats) {
  const patterns = [];
  if (!stats || stats.total.n < MIN_SAMPLES_FOR_ITERATION) return patterns;

  // Per (intent, cli) buckets with poor validated rate.
  for (const intent of Object.keys(stats.byIntentCli || {})) {
    const row = stats.byIntentCli[intent];
    const cliBuckets = Object.entries(row);
    if (!cliBuckets.length) continue;
    // Find the CLI with the worst rate (and enough samples) for this intent.
    const ranked = cliBuckets
      .filter(([, b]) => b.validatedRate !== null)
      .sort((a, b) => a[1].validatedRate - b[1].validatedRate);
    if (!ranked.length) continue;
    const [worstCli, worstBucket] = ranked[0];
    if (worstBucket.validatedRate < 0.5 && worstBucket.n >= outcomes.MIN_SAMPLES_FOR_STATS) {
      patterns.push(
        `Intent "${intent}" routed to "${worstCli}" only validated ${worstBucket.validated}/${worstBucket.n} times ` +
        `(${Math.round(worstBucket.validatedRate * 100)}%). ` +
        (worstBucket.corrected > 0 ? `${worstBucket.corrected} of those were corrected to a different CLI. ` : '') +
        (ranked.length > 1
          ? `By contrast, the best CLI for this intent has ${Math.round(ranked[ranked.length - 1][1].validatedRate * 100)}% validated.`
          : ''),
      );
    }
  }

  // Per-CLI rates as a general health signal.
  for (const cli of Object.keys(stats.byCli || {})) {
    const b = stats.byCli[cli];
    if (b.validatedRate !== null && b.validatedRate < 0.4 && b.n >= outcomes.MIN_SAMPLES_FOR_STATS) {
      patterns.push(
        `Across all intents, "${cli}" only validated ${b.validated}/${b.n} times (${Math.round(b.validatedRate * 100)}%). ` +
        `It is being picked too often.`,
      );
    }
  }

  return patterns;
}

function _buildIterationMessages(currentRules, patterns, totalSamples) {
  const sys = [
    'You are Symphonee proposing an edit to your OWN planner routing rules.',
    '',
    'You will see:',
    '  - the current rules block (verbatim)',
    '  - a list of failure patterns observed in the audit log',
    '',
    'Your job: propose a REVISED rules block that would have routed those',
    'failed cases better, while keeping the rest of the policy intact.',
    '',
    'Hard constraints:',
    '  - Output strict JSON: { rules: string, summary: string,',
    '    changes: array of { from: string, to: string } }',
    '  - "rules" is the FULL new rules block (replaces the old one verbatim).',
    '    Keep the same headers/structure ("CLI selection rules - follow these',
    '    strictly:", "Confidence rules:"). Do NOT change the output schema or',
    '    any JSON-contract instructions - those live elsewhere.',
    '  - "summary" is one sentence about what you changed and why.',
    '  - "changes" is a short list of before/after fragments so the user',
    '    can spot-check the diff quickly. 1-4 items.',
    '  - If the failure patterns do not support a confident edit, return',
    '    { rules: null, summary: "no confident change", changes: [] }.',
    '  - Plain ASCII. No emojis, em dashes, smart quotes.',
    '',
    `Total outcomes used for this analysis: ${totalSamples}`,
  ].join('\n');
  const user = [
    'Current rules block:',
    '"""',
    currentRules,
    '"""',
    '',
    'Observed failure patterns:',
    ...patterns.map(p => '  - ' + p),
    '',
    'Propose a revised rules block.',
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/**
 * Compose a proposal. Returns:
 *   { ok, proposal: { rules, summary, changes }, currentRules, patterns,
 *     totalSamples, model } on success,
 *   { ok: false, reason } when there is not enough data or the model
 *   declined to propose a change.
 */
async function propose(repoRoot, opts = {}) {
  const stats = outcomes.getStats(repoRoot);
  const totalSamples = stats.total.n;
  if (totalSamples < MIN_SAMPLES_FOR_ITERATION) {
    return {
      ok: false,
      reason: `not enough outcome data (have ${totalSamples}, need >= ${MIN_SAMPLES_FOR_ITERATION})`,
      totalSamples,
    };
  }
  const patterns = _detectFailurePatterns(stats);
  if (!patterns.length) {
    return {
      ok: false,
      reason: 'no failure patterns detected - planner appears healthy',
      totalSamples,
    };
  }
  const current = promptStore.loadRules(repoRoot);
  const messages = _buildIterationMessages(current.rules, patterns, totalSamples);
  let llmRes;
  try {
    llmRes = await llm.chatOllama(messages, {
      model: opts.model || REASONING_MODEL,
      format: 'json',
      timeoutMs: ITERATION_TIMEOUT_MS,
      numPredict: 4096,
    });
  } catch (err) {
    return { ok: false, reason: 'llm error', error: err.message, patterns, totalSamples };
  }
  const payload = llmRes.json || {};
  if (!payload.rules || typeof payload.rules !== 'string' || !payload.rules.trim()) {
    return {
      ok: false,
      reason: payload.summary || 'model declined to propose a change',
      patterns,
      totalSamples,
      model: llmRes.model,
    };
  }
  return {
    ok: true,
    proposal: {
      rules: payload.rules,
      summary: payload.summary || '(no summary)',
      changes: Array.isArray(payload.changes) ? payload.changes.slice(0, 8) : [],
    },
    currentRules: current.rules,
    currentSource: current.source,
    patterns,
    totalSamples,
    model: llmRes.model,
  };
}

/**
 * Apply a proposed rules block. The user MUST opt in - we never write
 * automatically. Returns prompt-store's saveRules result plus the new
 * source/version.
 */
function accept(repoRoot, rules, { note = null } = {}) {
  if (!rules || typeof rules !== 'string' || !rules.trim()) {
    return { ok: false, error: 'rules must be a non-empty string' };
  }
  const r = promptStore.saveRules(repoRoot, rules, { source: 'self-iterate', note });
  if (!r.ok) return r;
  const cur = promptStore.loadRules(repoRoot);
  return { ok: true, source: cur.source, file: r.file };
}

/**
 * Revert to the previous rules state (one step back).
 */
function revert(repoRoot) {
  return promptStore.revertRules(repoRoot);
}

module.exports = {
  propose,
  accept,
  revert,
  _detectFailurePatterns,
  _buildIterationMessages,
  MIN_SAMPLES_FOR_ITERATION,
};
