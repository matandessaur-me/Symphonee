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
const llm = require('../mind/llm');
const store = require('../mind/store');
const recallMod = require('../mind/recall');

const MIN_MIND_SCORE = 3.5;     // top hit must beat this to ground a local answer
const MIN_GROUND_HITS = 2;      // need at least N hits above floor to synthesize
const MIND_FLOOR = 1.5;         // hits below this are not citation-worthy
const MAX_CITED = 5;            // how many hits feed into the synthesis prompt
const SYNTHESIS_MODEL = process.env.SYMPHONEE_REASONING_MODEL || 'gemma4:26b';
const SYNTHESIS_TIMEOUT_MS = 90_000;

// Intents the brain handles locally vs escalates. Anything that needs a
// real workspace action (code edits, plugin calls, app automation) MUST
// escalate - we never silently swallow those.
const LOCAL_INTENTS = new Set(['recall', 'greeting', 'ambiguous']);
const MIND_FIRST_INTENTS = new Set(['code-question', 'browse-files']);
const ALWAYS_ESCALATE = new Set([
  'code-action',
  'plan',
  'plugin-call',
  'apps-action',
  'browser-action',
]);

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
    'You are Symphonee answering a question from memory.',
    'You will be given the user\'s question and a ranked list of memory',
    'snippets the brain has retrieved. Synthesize a SHORT, factual answer.',
    '',
    'Rules:',
    '  - Only use facts from the snippets. Do NOT invent details.',
    '  - If the snippets do not actually answer the question, return',
    '    JSON { "answer": null, "reason": "snippets do not answer" }.',
    '  - When you cite a snippet, reference it by its id (e.g. [id]).',
    '  - Be terse. 1-3 sentences usually. No preamble like "Based on the',
    '    snippets..." - just the answer.',
    '  - Plain ASCII. No emojis, em dashes, smart quotes.',
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
 * Try to answer from Mind. Returns null if there is no graph, no hits,
 * or the top hit is below the grounding threshold. Otherwise returns
 * { answer, citedNodeIds, hits, model } from a synthesis pass.
 */
async function _answerFromMind({ input, intent, repoRoot, space, ctx }) {
  const graph = store.loadGraph(repoRoot, space);
  if (!graph || !graph.nodes || !graph.nodes.length) return null;
  const r = recallMod.recall(graph, { question: input, limit: MAX_CITED * 2 });
  if (!r || !r.hits || !r.hits.length) return null;
  const strong = r.hits.filter(h => h.score >= MIND_FLOOR);
  if (strong.length < MIN_GROUND_HITS) return null;
  if (strong[0].score < MIN_MIND_SCORE) return null;
  const messages = _buildSynthesisMessages(input, strong, intent);
  let llmRes;
  try {
    llmRes = await llm.chatOllama(messages, {
      model: SYNTHESIS_MODEL,
      format: 'json',
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const payload = llmRes.json || {};
  if (!payload.answer) return null;
  const citedNodeIds = Array.isArray(payload.cited)
    ? payload.cited.filter(id => strong.find(h => h.id === id))
    : strong.slice(0, MIN_GROUND_HITS).map(h => h.id);
  return {
    ok: true,
    answer: String(payload.answer).slice(0, 4000),
    confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.6,
    citedNodeIds,
    hitsUsed: strong.length,
    model: llmRes.model,
  };
}

/**
 * Local-only answer (no Mind grounding). Cheaper escalation gate -
 * gemma decides if it can answer at all without tools, otherwise
 * returns null (caller escalates).
 */
async function _answerFromLocal({ input, intent }) {
  const messages = _buildLocalMessages(input, intent);
  let llmRes;
  try {
    llmRes = await llm.chatOllama(messages, {
      model: SYNTHESIS_MODEL,
      format: 'json',
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const payload = llmRes.json || {};
  if (!payload.answer) return null;
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
  const planResult = await planner.planRoute(input, { ui: ctx.ui, intent: ctx.intent });
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

  // Mind-first path: recall, code-question, browse-files, ambiguous.
  // We always try Mind before any LLM call - cheapest path.
  if (LOCAL_INTENTS.has(intent) || MIND_FIRST_INTENTS.has(intent)) {
    let mindResult = null;
    try {
      mindResult = await _answerFromMind({
        input,
        intent: ctx.intent,
        repoRoot: ctx.repoRoot,
        space: ctx.space,
      });
    } catch (err) {
      mindResult = { ok: false, error: err.message };
    }
    if (mindResult && mindResult.ok) {
      return {
        source: 'mind',
        answer: mindResult.answer,
        confidence: mindResult.confidence,
        citedNodeIds: mindResult.citedNodeIds,
        hitsUsed: mindResult.hitsUsed,
        model: mindResult.model,
        decision,
        tookMs: Date.now() - startedAt,
      };
    }

    // No useful Mind grounding. For pure recall / greeting / ambiguous
    // we try local gemma as a last attempt before escalating.
    if (LOCAL_INTENTS.has(intent)) {
      let localResult = null;
      try {
        localResult = await _answerFromLocal({ input, intent: ctx.intent });
      } catch (err) {
        localResult = { ok: false, error: err.message };
      }
      if (localResult && localResult.ok) {
        return {
          source: 'local',
          answer: localResult.answer,
          confidence: localResult.confidence,
          citedNodeIds: [],
          model: localResult.model,
          decision,
          tookMs: Date.now() - startedAt,
        };
      }
    }
    // Fall through to escalate - Mind couldn't ground, local couldn't help.
  }

  // Default: escalate. The orchestrator decides which CLI to dispatch
  // based on decision.primary_cli.
  return {
    source: 'escalate',
    reason: 'local could not handle',
    decision,
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
