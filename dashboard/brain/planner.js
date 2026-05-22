/**
 * Symphonee planner - the two-tier reasoning loop.
 *
 * Tier 1 (planRoute): triage and routing. Called on every /api/symphonee/think
 *   request. Uses qwen2.5:1.5b by default for sub-second classification of
 *   intent (code | recall | action | ambiguous | greeting), tool selection,
 *   and confidence. Escalates to gemma4:26b when confidence is below
 *   ESCALATION_THRESHOLD or the input is structurally complex.
 *
 * Tier 2 (recomputeIntent): the off-hot-path reasoning step. Called from the
 *   intent manager's debounced recompute. Uses gemma4:26b because intent is
 *   the foundation for every subsequent decision and quality matters more
 *   than latency.
 *
 * Both tiers go through dashboard/mind/llm.js so model selection and
 * health-check semantics stay consistent. Models are NOT hard-coded inside
 * the prompts; we pass them explicitly via opts.model so the operator can
 * swap them without code changes.
 *
 * Why no frontier model here: this file is Symphonee's brain. The frontier
 * CLIs (Claude Opus, GPT, Gemini Pro) are dispatched as TOOLS via
 * orchestrator.spawn once the planner has decided to escalate. Symphonee
 * conducts; it does not replace the orchestra.
 */

'use strict';

const llm = require('../mind/llm');

const TRIAGE_MODEL = process.env.SYMPHONEE_TRIAGE_MODEL || 'qwen2.5:1.5b';
const REASONING_MODEL = process.env.SYMPHONEE_REASONING_MODEL || 'gemma4:26b';
const ESCALATION_THRESHOLD = 0.7;

const KNOWN_INTENTS = [
  'code-question',
  'code-action',
  'recall',
  'teach',
  'plan',
  'browse-files',
  'plugin-call',
  'apps-action',
  'browser-action',
  'greeting',
  'ambiguous',
];

const TOOL_REGISTRY_HINT = [
  'recall (POST /api/mind/recall) - prior work, past decisions',
  'query (POST /api/mind/query) - code structure questions',
  'teach (POST /api/mind/teach) - persist a durable rule the user just stated',
  'spawn-claude (POST /api/orchestrator/spawn cli:claude-code) - heavy reasoning, coding',
  'spawn-codex (POST /api/orchestrator/spawn cli:codex) - SQL, refactors, tests',
  'spawn-gemini (POST /api/orchestrator/spawn cli:gemini) - long-context analysis',
  'spawn-grok (POST /api/orchestrator/spawn cli:grok) - quick takes, summaries',
  'plugin-route - call /api/plugins/<id>/* when the active repo matches plugin keywords',
  'show-diff (Show-Diff.ps1) - render working changes to the diff viewer',
  'browser (POST /api/browser/router/run) - web automation',
  'apps (POST /api/apps/do) - desktop app automation',
];

// Intent classes that REQUIRE a CLI worker. If the planner returns one of
// these intents, primary_cli must NOT be "none" - the sanity check in
// planRoute will override to a sensible default.
const INTENTS_REQUIRING_CLI = new Set([
  'code-question',
  'code-action',
  'plan',
  'browse-files',
]);

// Default CLI per intent when the model picks "none" but the intent class
// implies a worker is needed. claude-code is the safe default for
// code-heavy work; codex is preferred for SQL/refactor/test work.
const INTENT_DEFAULT_CLI = {
  'code-question': 'claude-code',
  'code-action': 'claude-code',
  'plan': 'claude-code',
  'browse-files': 'claude-code',
};

function _buildPlannerMessages(input, context) {
  const intentSummary = context && context.intent && context.intent.summary
    ? `Current intent (do NOT copy this into rationale - it is background context only): ${context.intent.summary}`
    : 'Current intent: unknown';
  const repoLine = context && context.ui && context.ui.activeRepo
    ? `Active repo: ${context.ui.activeRepo}`
    : 'Active repo: none';
  const sys = [
    'You are Symphonee, the brain of a multi-CLI AI terminal.',
    'Your job is to classify the user input and pick a route.',
    'You do not answer the question. You decide which tool answers it.',
    '',
    'Available routes (pick one or more):',
    ...TOOL_REGISTRY_HINT.map(t => '- ' + t),
    '',
    'Output strict JSON with keys:',
    '  intent: one of ' + KNOWN_INTENTS.join(' | '),
    '  needed_tools: array of route names from the list above (or [])',
    '  primary_cli: claude-code | codex | gemini | grok | qwen | copilot | none',
    '  rationale: one short sentence ABOUT THIS SPECIFIC INPUT (not background context)',
    '  confidence: 0..1',
    '  is_teaching: boolean (true if user is teaching a durable rule)',
    '',
    'CLI selection rules - follow these strictly:',
    '  - Use "none" ONLY for: pure greetings, trivial acknowledgements, or',
    '    questions that can be answered from memory (recall) alone.',
    '  - For code-question, code-action, plan, or browse-files intents,',
    '    you MUST pick a real CLI - never "none". Default: "claude-code".',
    '  - Prefer "codex" for SQL, schema changes, refactors, or test writing.',
    '  - Prefer "gemini" for long-context analysis (large docs, many files).',
    '  - Prefer "grok" only for quick summaries or off-the-cuff takes.',
    '  - When in doubt for any non-trivial task, pick "claude-code".',
    '',
    'Confidence rules:',
    '  - Only return confidence >= 0.7 when you are SURE about both intent AND primary_cli.',
    '  - If the intent is clear but the CLI is uncertain, return confidence < 0.7.',
    '  - High confidence with primary_cli="none" on a non-trivial task is a contradiction - lower the confidence.',
    '',
    repoLine,
    intentSummary,
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: String(input).slice(0, 2000) },
  ];
}

// Sanity-check a decision and patch obvious inconsistencies. Returns the
// (possibly mutated) decision plus a list of patches applied so the audit
// log can show what the override layer touched. Two patches today:
//   1. intent-implies-cli: if the intent requires a CLI but primary_cli
//      came back as "none" (or missing), force a sensible default.
//   2. confidence-clamp: if primary_cli was overridden, knock confidence
//      down so escalation can still kick in.
function _sanityCheckDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    return { decision, patches: [] };
  }
  const patches = [];
  const intent = decision.intent;
  const cli = decision.primary_cli;
  if (intent && INTENTS_REQUIRING_CLI.has(intent) && (!cli || cli === 'none')) {
    const fallback = INTENT_DEFAULT_CLI[intent] || 'claude-code';
    decision.primary_cli = fallback;
    patches.push({
      kind: 'intent-implies-cli',
      reason: `intent="${intent}" requires a CLI; overrode primary_cli "${cli || 'missing'}" -> "${fallback}"`,
    });
    // Knock confidence down so escalation can re-evaluate. The triage
    // model just contradicted itself; we should not trust its confidence.
    if (typeof decision.confidence === 'number' && decision.confidence > 0.5) {
      decision.confidence = 0.5;
      patches.push({ kind: 'confidence-clamp', reason: 'lowered confidence after CLI override' });
    }
  }
  return { decision, patches };
}

/**
 * Classify the input and return a routing decision.
 *
 * Pipeline:
 *   1. Triage with the small model (qwen). Apply sanity check.
 *   2. Decide whether to escalate. Two reasons to escalate:
 *        a) triage confidence < ESCALATION_THRESHOLD, OR
 *        b) the sanity check had to patch a contradiction (the small model
 *           said "none" for an intent that requires a CLI, etc).
 *   3. If escalating, call the bigger model and apply the sanity check to
 *      its output too - the big model can also make mistakes; the check
 *      is layered defence.
 */
async function planRoute(input, context = {}) {
  const messages = _buildPlannerMessages(input, context);
  let triage;
  try {
    triage = await llm.chatOllama(messages, { model: TRIAGE_MODEL, format: 'json', timeoutMs: 8000 });
  } catch (err) {
    return {
      ok: false,
      stage: 'triage',
      error: err.message,
      escalated: false,
      decision: null,
    };
  }
  const triageRaw = triage.json || {};
  const triageChecked = _sanityCheckDecision({ ...triageRaw });
  const triageConfidence = typeof triageChecked.decision.confidence === 'number' ? triageChecked.decision.confidence : 0;
  const forceEscalate = triageChecked.patches.length > 0;

  if (!forceEscalate && triageConfidence >= ESCALATION_THRESHOLD) {
    return {
      ok: true,
      stage: 'triage',
      escalated: false,
      model: triage.model,
      decision: triageChecked.decision,
      patches: triageChecked.patches,
    };
  }

  // Escalate. forceEscalate=true means the small model produced an
  // inconsistent decision (e.g. code-action + primary_cli=none) and we
  // want the bigger model's read, even though triage "confidence" looked
  // high. The triage confidence is unreliable in exactly these cases.
  let escalation;
  try {
    escalation = await llm.chatOllama(messages, { model: REASONING_MODEL, format: 'json', timeoutMs: 60000 });
  } catch (err) {
    return {
      ok: true,
      stage: 'triage-only',
      escalated: false,
      escalationError: err.message,
      model: triage.model,
      decision: triageChecked.decision,
      patches: triageChecked.patches,
      forceEscalated: forceEscalate,
    };
  }
  const escalationRaw = escalation.json || triageChecked.decision;
  const escalationChecked = _sanityCheckDecision({ ...escalationRaw });
  return {
    ok: true,
    stage: 'escalated',
    escalated: true,
    forceEscalated: forceEscalate,
    triageModel: triage.model,
    triageConfidence,
    triagePatches: triageChecked.patches,
    model: escalation.model,
    decision: escalationChecked.decision,
    patches: escalationChecked.patches,
  };
}

/**
 * Produce a one-sentence intent summary from recent evidence. Called by the
 * intent manager off the hot path; uses the bigger local model because the
 * output is read by every downstream feature.
 */
async function recomputeIntent({ ui, current, evidence }) {
  if (!evidence || !evidence.length) return null;
  const lines = evidence.slice(-12).map(ev => {
    const kind = ev.kind || 'event';
    const where = ev.repo ? ` [${ev.repo}]` : '';
    const detail = (ev.detail || ev.label || ev.file || '').toString().slice(0, 200);
    return `- ${kind}${where}: ${detail}`;
  });
  const priorLine = current && current.summary
    ? `Prior intent: ${current.summary} (conf ${current.confidence || 0})`
    : 'Prior intent: unknown';
  const repoLine = ui && ui.activeRepo
    ? `Active repo: ${ui.activeRepo}`
    : 'Active repo: none';
  const sys = [
    'You are Symphonee, observing what the user is doing.',
    'Read the recent activity below and update your theory of the current task.',
    'Be specific, not generic. Stay one sentence.',
    'Do NOT invent things not present in the evidence.',
    '',
    repoLine,
    priorLine,
    '',
    'Output strict JSON: { summary: string, confidence: 0..1, currentRepo: string|null }',
  ].join('\n');
  const user = [
    'Recent activity:',
    ...lines,
    '',
    'Update the intent.',
  ].join('\n');
  try {
    const r = await llm.chatOllama(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { model: REASONING_MODEL, format: 'json', timeoutMs: 60000 }
    );
    const out = r.json || {};
    return {
      summary: typeof out.summary === 'string' ? out.summary.slice(0, 280) : null,
      confidence: typeof out.confidence === 'number' ? Math.max(0, Math.min(1, out.confidence)) : 0.5,
      currentRepo: out.currentRepo || (ui && ui.activeRepo) || null,
      model: r.model,
    };
  } catch (err) {
    console.warn('[brain/planner] recomputeIntent error:', err.message);
    return null;
  }
}

module.exports = {
  planRoute,
  recomputeIntent,
  TRIAGE_MODEL,
  REASONING_MODEL,
  ESCALATION_THRESHOLD,
  KNOWN_INTENTS,
  INTENTS_REQUIRING_CLI,
  INTENT_DEFAULT_CLI,
  _sanityCheckDecision, // exported for tests
};
