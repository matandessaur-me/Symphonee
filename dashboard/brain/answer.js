/**
 * Local-first answering - the productivity + token-saving faculty.
 *
 * Today every user prompt that lacks an explicit cli either spawns a
 * frontier CLI worker (burns API tokens) or returns "cli required"
 * (nothing). After this module: the brain tries to answer LOCALLY first.
 * Frontier dispatch only happens when local cannot.
 *
 * Three-source flow:
 *   1. Mind     - if the prompt is a recall question and Mind has strong
 *                 hits, synthesize a short answer via gemma using those
 *                 hits as citations. Zero frontier tokens.
 *   2. Local    - if the prompt is a simple question gemma can handle
 *                 with the intent context, answer directly. No Mind
 *                 grounding (use sparingly; we prefer Mind-cited answers
 *                 for trust).
 *   3. Escalate - real work that needs a frontier model (code-action,
 *                 plan, plugin-call, apps-action, browser-action). The
 *                 caller (orchestrator) is responsible for the dispatch.
 *
 * Return shape: { source, answer, decision, citedNodeIds, tookMs }.
 * source: 'mind' | 'local' | 'escalate' | 'no-op'.
 *
 * "no-op" fires for pure greetings and the brain's intent-of-teach
 * recognition - those don't need an answer, they need acknowledgement.
 *
 * Confidence policy: prefer escalation over a bad local answer. The
 * thresholds (MIN_MIND_SCORE, MIN_GROUND_HITS) are deliberately
 * conservative so we never return a confidently-wrong local answer
 * when a frontier model would have been right.
 */

'use strict';

const planner = require('./planner');
const llm = require('../lib/llm');
const { createMindClient } = require('../lib/mind-client');
const perf = require('./perf');

const MIN_MIND_SCORE = 3.5;     // top hit must beat this to ground a local answer
const MIN_GROUND_HITS = 2;      // need at least N hits above floor to synthesize
const MIND_FLOOR = 1.5;         // hits below this are not citation-worthy
const MAX_CITED = 5;            // how many hits feed into the synthesis prompt
const SYNTHESIS_MODEL = process.env.SYMPHONEE_REASONING_MODEL || 'gemma4:26b';
const SYNTHESIS_TIMEOUT_MS = 90_000;

// Intent taxonomy:
//   ALWAYS_ESCALATE - needs a real workspace action; never answer locally
//   MIND_FIRST      - try Mind synthesis; escalate if Mind can't ground
//   LOCAL_TRY       - try local gemma with no grounding (for genuinely
//                     general questions where Mind has nothing useful)
//
// Note: "recall" is MIND_FIRST, NOT LOCAL_TRY. If Mind cannot ground a
// recall question, escalating to a frontier CLI is strictly better than
// having gemma hallucinate "I don't know" - the frontier model can at
// least search the codebase and check git history. We never want the
// brain to confidently say "no information" when the user explicitly
// asked Mind a question.
const ALWAYS_ESCALATE = new Set([
  'code-action',
  'plan',
  'plugin-call',
  'apps-action',
  'browser-action',
]);
const MIND_FIRST_INTENTS = new Set(['recall', 'code-question', 'browse-files']);
const LOCAL_TRY_INTENTS = new Set(['ambiguous']);
// Backwards-compat export: anything that COULD try the local path.
const LOCAL_INTENTS = new Set([...LOCAL_TRY_INTENTS, 'greeting']);

function _safeSlice(s, n) {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : String(s);
  return str.length > n ? str.slice(0, n) : str;
}

function _buildSynthesisMessages(input, hits, intent) {
  const intentLine = intent && intent.summary
    ? `User's current intent (background): ${intent.summary}`
    : 'User intent: unknown';
  const sys = [
    'You are Symphonee answering from the user\'s OWN memory.',
    '',
    'The snippets below are the user\'s own notes, prior conversations,',
    'memory cards, and work logs about the topic in their question.',
    'Your job is to SUMMARIZE what those snippets say in 1-4 sentences.',
    '',
    'MANDATORY RULES (read carefully):',
    '  1. If you see 2 or more snippets that touch on the topic, you MUST',
    '     produce a non-null answer summarizing what they describe. Do',
    '     NOT return answer: null in that case. The snippets ARE the',
    '     answer material - even if they look like conversation excerpts,',
    '     status updates, or partial logs.',
    '  2. Treat snippets as facts the user already knows. Rephrase and',
    '     condense them. Never claim "no information was provided" if',
    '     the snippets exist - that contradicts the input.',
    '  3. Only return answer: null when the snippets are genuinely about',
    '     a different topic. In that case set reason to "off-topic".',
    '  4. Do NOT invent details not present in the snippets.',
    '  5. Cite snippet ids you used (e.g. [n1]).',
    '  6. Be terse. 1-4 sentences. No preamble.',
    '  7. Plain ASCII. No emojis, em dashes, smart quotes.',
    '',
    intentLine,
    '',
    'Output strict JSON:',
    '  { answer: string|null, cited: array of snippet ids, confidence: 0..1 }',
  ].join('\n');
  const snippetBlock = hits.slice(0, MAX_CITED).map(h => {
    const head = `[${h.id}] (${h.kind}, score ${h.score})`;
    const body = _safeSlice(h.snippet || h.label || '', 360);
    return head + '\n' + body;
  }).join('\n\n');
  const user = [
    'Question:',
    _safeSlice(input, 1000),
    '',
    'Snippets:',
    snippetBlock || '(none)',
    '',
    'Answer the question from the snippets above.',
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

function _buildLocalMessages(input, intent) {
  const intentLine = intent && intent.summary
    ? `Recent user context: ${intent.summary}`
    : '';
  const sys = [
    'You are Symphonee answering a simple question directly.',
    'You do not have access to code, files, or external tools - just',
    'general knowledge and the user\'s context.',
    '',
    'Rules:',
    '  - If the question requires reading code, running commands, or',
    '    inspecting files, return JSON { "answer": null, "reason":',
    '    "needs tools" }. Symphonee will escalate to a frontier CLI.',
    '  - Otherwise answer in 1-3 sentences. Terse.',
    '  - Plain ASCII only.',
    '',
    intentLine,
    '',
    'Output strict JSON: { answer: string|null, confidence: 0..1 }',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: _safeSlice(input, 1000) },
  ];
}

/**
 * Try to answer from Mind. Returns a result object with explicit reason
 * codes so callers can surface diagnostics. Shape:
 *
 *   { ok: true, answer, confidence, citedNodeIds, hitsUsed, model }
 *   OR
 *   { ok: false, reason, mindHitsTotal, topScore }
 */
async function _answerFromMind({ input, intent, repoRoot, space, mindClient }) {
  // Stage 1 (mind-extraction Phase 1): consume Mind through the client
  // contract instead of reading the graph in-process. Default transport is
  // in-process (lib/mind-client.js), so behaviour is identical to the old
  // store.loadGraph + recall path; callers can inject an http-backed client
  // for the extracted/remote deployment.
  const mind = mindClient || createMindClient({ transport: 'inproc', repoRoot, space });
  let r;
  try {
    r = await mind.recall({ question: input, limit: MAX_CITED * 2, space });
  } catch (err) {
    return { ok: false, reason: 'mind-threw', error: err.message, mindHitsTotal: 0 };
  }
  if (!r || !r.hits || !r.hits.length) {
    // The client returns a `message` (e.g. "no graph for this space") when the
    // space has no graph at all - preserve the mind-empty vs no-hits split.
    return { ok: false, reason: r && r.message ? 'mind-empty' : 'no-mind-hits', mindHitsTotal: 0 };
  }
  const strong = r.hits.filter(h => h.score >= MIND_FLOOR);
  const topScore = r.hits[0].score;
  if (strong.length < MIN_GROUND_HITS) {
    return { ok: false, reason: 'too-few-strong-hits', mindHitsTotal: r.hits.length, strongCount: strong.length, topScore };
  }
  if (topScore < MIN_MIND_SCORE) {
    return { ok: false, reason: 'top-hit-below-threshold', mindHitsTotal: r.hits.length, topScore };
  }
  const messages = _buildSynthesisMessages(input, strong, intent);
  let llmRes;
  try {
    const _start = Date.now();
    llmRes = await llm.chatOllama(messages, {
      model: SYNTHESIS_MODEL,
      format: 'json',
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
      numPredict: 4096,
    });
    perf.recordLatency('answer.synth', Date.now() - _start);
  } catch (err) {
    return { ok: false, reason: 'synthesis-error', error: err.message, mindHitsTotal: r.hits.length, topScore };
  }
  const payload = llmRes.json || {};
  if (!payload.answer) {
    return {
      ok: false,
      reason: 'synthesis-returned-null',
      synthesisModel: llmRes.model,
      synthesisReason: payload.reason || null,
      mindHitsTotal: r.hits.length,
      strongCount: strong.length,
      topScore,
    };
  }
  const citedNodeIds = Array.isArray(payload.cited)
    ? payload.cited.filter(id => strong.find(h => h.id === id))
    : strong.slice(0, MIN_GROUND_HITS).map(h => h.id);
  return {
    ok: true,
    answer: String(payload.answer).slice(0, 4000),
    confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.6,
    citedNodeIds,
    hitsUsed: strong.length,
    topScore,
    model: llmRes.model,
  };
}

/**
 * Local-only answer (no Mind grounding). Cheaper escalation gate -
 * gemma decides if it can answer at all without tools.
 *
 * Shape:
 *   { ok: true, answer, confidence, model }
 *   OR
 *   { ok: false, reason, ... }
 */
async function _answerFromLocal({ input, intent }) {
  const messages = _buildLocalMessages(input, intent);
  let llmRes;
  try {
    const _start = Date.now();
    llmRes = await llm.chatOllama(messages, {
      model: SYNTHESIS_MODEL,
      format: 'json',
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
      numPredict: 4096,
    });
    perf.recordLatency('answer.synth', Date.now() - _start);
  } catch (err) {
    return { ok: false, reason: 'local-error', error: err.message };
  }
  const payload = llmRes.json || {};
  if (!payload.answer) {
    return { ok: false, reason: 'local-declined', localReason: payload.reason || null, model: llmRes.model };
  }
  return {
    ok: true,
    answer: String(payload.answer).slice(0, 4000),
    confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.5,
    model: llmRes.model,
  };
}

/**
 * The unified entry point. Plans, then routes to Mind / local / escalate.
 *
 * @param input  the prompt to answer
 * @param ctx    { repoRoot, space, intent, ui }
 * @returns { source, answer, citedNodeIds, decision, tookMs, model, escalation }
 */
async function answer(input, ctx = {}) {
  const startedAt = Date.now();
  if (!input || typeof input !== 'string') {
    return { source: 'no-op', error: 'input required', tookMs: 0 };
  }
  const planResult = await planner.planRoute(input, {
    ui: ctx.ui,
    intent: ctx.intent,
    outcomeHints: ctx.outcomeHints || [],
    repoRoot: ctx.repoRoot,
  });
  const decision = planResult && planResult.decision || {};
  const intent = decision.intent || 'ambiguous';

  // Greeting / acknowledgement: no answer needed, no LLM call.
  if (intent === 'greeting') {
    return {
      source: 'no-op',
      reason: 'greeting',
      decision,
      tookMs: Date.now() - startedAt,
    };
  }

  // Anything that needs real tools (code edits, plugin calls, app actions)
  // escalates. The brain refuses to fake those locally.
  if (ALWAYS_ESCALATE.has(intent)) {
    return {
      source: 'escalate',
      reason: 'intent requires a frontier worker',
      decision,
      tookMs: Date.now() - startedAt,
    };
  }

  const diagnostics = { mindAttempted: false, localAttempted: false };

  // Mind-first path: recall, code-question, browse-files. These ask
  // about specific stored content - if Mind cannot ground, escalate to
  // a frontier CLI rather than letting local gemma hallucinate.
  if (MIND_FIRST_INTENTS.has(intent)) {
    diagnostics.mindAttempted = true;
    let mindResult = null;
    try {
      mindResult = await _answerFromMind({
        input,
        intent: ctx.intent,
        repoRoot: ctx.repoRoot,
        space: ctx.space,
        mindClient: ctx.mindClient,
      });
    } catch (err) {
      mindResult = { ok: false, reason: 'mind-threw', error: err.message };
    }
    diagnostics.mind = mindResult;
    if (mindResult && mindResult.ok) {
      return {
        source: 'mind',
        answer: mindResult.answer,
        confidence: mindResult.confidence,
        citedNodeIds: mindResult.citedNodeIds,
        hitsUsed: mindResult.hitsUsed,
        model: mindResult.model,
        decision,
        diagnostics,
        tookMs: Date.now() - startedAt,
      };
    }
    // Mind couldn't ground - escalate directly. No local fallback for
    // memory-style questions; frontier model has tools we don't.
  }

  // Local-try path: ambiguous prompts where Mind has nothing useful and
  // a general gemma answer might still help.
  if (LOCAL_TRY_INTENTS.has(intent)) {
    diagnostics.localAttempted = true;
    let localResult = null;
    try {
      localResult = await _answerFromLocal({ input, intent: ctx.intent });
    } catch (err) {
      localResult = { ok: false, reason: 'local-threw', error: err.message };
    }
    diagnostics.local = localResult;
    if (localResult && localResult.ok) {
      return {
        source: 'local',
        answer: localResult.answer,
        confidence: localResult.confidence,
        citedNodeIds: [],
        model: localResult.model,
        decision,
        diagnostics,
        tookMs: Date.now() - startedAt,
      };
    }
  }

  // Default: escalate. The orchestrator decides which CLI to dispatch
  // based on decision.primary_cli.
  return {
    source: 'escalate',
    reason: 'local could not handle',
    decision,
    diagnostics,
    tookMs: Date.now() - startedAt,
  };
}

module.exports = {
  answer,
  // exported for tests
  _buildSynthesisMessages,
  _buildLocalMessages,
  LOCAL_INTENTS,
  MIND_FIRST_INTENTS,
  ALWAYS_ESCALATE,
  MIN_MIND_SCORE,
  MIN_GROUND_HITS,
};
