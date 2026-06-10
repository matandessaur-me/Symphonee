/**
 * Symphonee brain - the reasoning layer that sits above Mind.
 *
 * Mind is memory. Brain is the loop that reads memory, classifies inputs,
 * picks tools, and (eventually) acts. CLIs become tools the brain dispatches
 * via the orchestrator; the brain itself never replaces the frontier models.
 *
 * There is no off switch. The brain is always on, always maintaining intent,
 * always available for the orchestrator to consult. Making Symphonee smarter
 * is not an option the user has to opt into.
 *
 * Endpoints:
 *   POST /api/symphonee/think           - planner front door
 *   GET  /api/symphonee/intent          - current intent state
 *   POST /api/symphonee/intent/notify   - push evidence (file edit, drawer, etc)
 *   POST /api/symphonee/intent/recompute- force a recompute with pending evidence
 *   POST /api/symphonee/intent/pause    - pause auto-recompute
 *   POST /api/symphonee/intent/resume   - resume auto-recompute
 *   GET  /api/symphonee/status          - brain config + intent snapshot
 *   GET  /api/symphonee/instructions    - markdown doc for CLIs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const intentModule = require('./intent');
const planner = require('./planner');
const sequencesModule = require('./sequences');
const synthesizeModule = require('./synthesize');
const answerModule = require('./answer');
const outcomesModule = require('./outcomes');
const routeLogModule = require('./route-log');
const promptStoreModule = require('./prompt-store');
const selfIterateModule = require('./self-iterate');
const perfModule = require('./perf');
const ollamaSetup = require('../lib/ollama-setup');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function mountBrain(addRoute, json, ctx) {
  const { repoRoot, broadcast, getUiContext } = ctx;

  // Singleton intent manager bound to onRecompute -> planner.recomputeIntent
  const intent = intentModule.createIntentManager({
    repoRoot,
    broadcast,
    getUiContext,
    onRecompute: async ({ ui, current, evidence }) => {
      return planner.recomputeIntent({ ui, current, evidence });
    },
  });

  // Planning-decision log (in-memory ring buffer). Persisted across the
  // session lifetime so /api/symphonee/decisions can show what the brain
  // routed and why. Each entry gets a stable `id` so the outcomes module
  // can later attach feedback (validated / contradicted / corrected /
  // unused) to a specific decision.
  const decisionLog = [];
  const DECISION_LOG_MAX = 200;
  function _makeDecisionId() {
    return 'dec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }
  function logDecision(entry) {
    const id = entry.id || _makeDecisionId();
    const record = { id, at: new Date().toISOString(), ...entry };
    decisionLog.push(record);
    if (decisionLog.length > DECISION_LOG_MAX) decisionLog.shift();
    // Stage-0 instrumentation: durably persist the recall-vs-escalate signal
    // so it survives restart and Stage 4 can measure routing on real traffic.
    // Both call sites (/think and the orchestrator plan()) funnel through
    // here, so this single hook captures all real traffic. Wrapped in a guard
    // because instrumentation must never be able to break a routing request -
    // routeLog.record() already swallows IO errors, this catches everything
    // else (e.g. a malformed entry).
    try {
      const classification = planner.classifyRoute(record);
      routeLogModule.record(repoRoot, {
        decisionId: id,
        input: record.input,
        source: record.source,
        plan: record,
        classification,
        tookMs: record.tookMs,
        escalationThreshold: planner.ESCALATION_THRESHOLD,
      });
    } catch (_) { /* instrumentation must never break routing */ }
    return record;
  }
  function findDecision(id) {
    return decisionLog.find(d => d.id === id) || null;
  }

  // Compose a small set of advisory hints derived from past outcome stats.
  // Returns at most one hint per intent class for which we have enough
  // sample data (>= MIN_SAMPLES_FOR_STATS). Empty array if the brain has
  // no usable feedback yet - the planner prompt stays unchanged in that
  // case, no token cost.
  function getOutcomeHints() {
    try {
      const stats = outcomesModule.getStats(repoRoot);
      const hints = [];
      for (const intent of Object.keys(stats.byIntentCli || {})) {
        const hint = outcomesModule.buildPromptHint(stats, intent);
        if (hint) hints.push(hint);
      }
      return hints;
    } catch (_) { return []; }
  }

  // ── POST /api/symphonee/think ───────────────────────────────────────────
  addRoute('POST', '/api/symphonee/think', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const input = body.input || body.prompt || body.text;
    if (!input || typeof input !== 'string') {
      return json(res, { error: 'input required' }, 400);
    }
    const ui = getUiContext ? getUiContext() : {};
    const current = intent.get();
    const startedAt = Date.now();
    const plan = await planner.planRoute(input, { ui, intent: current, outcomeHints: getOutcomeHints(), repoRoot });
    const tookMs = Date.now() - startedAt;
    const entry = {
      input: input.slice(0, 240),
      ok: plan.ok,
      stage: plan.stage,
      escalated: plan.escalated,
      forceEscalated: plan.forceEscalated,
      triageConfidence: plan.triageConfidence,
      triagePatches: plan.triagePatches,
      patches: plan.patches,
      model: plan.model,
      triageModel: plan.triageModel,
      decision: plan.decision,
      error: plan.error,
      tookMs,
    };
    const logged = logDecision(entry);
    if (broadcast) {
      broadcast({ type: 'symphonee-plan', payload: logged });
    }
    return json(res, { ...plan, tookMs, decisionId: logged.id });
  });

  // ── GET /api/symphonee/decisions ────────────────────────────────────────
  addRoute('GET', '/api/symphonee/decisions', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const safeLimit = Math.max(1, Math.min(DECISION_LOG_MAX, limit));
    return json(res, {
      total: decisionLog.length,
      decisions: decisionLog.slice(-safeLimit).reverse(),
    });
  });

  // ── GET /api/symphonee/route-log ────────────────────────────────────────
  // Durable Stage-0 instrumentation: the raw recall-vs-escalate decision
  // stream, newest first. Unlike /decisions (in-memory, 200-cap, lost on
  // restart) this survives restart and is the substrate Stage 4 measures
  // routing accuracy against.
  addRoute('GET', '/api/symphonee/route-log', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const safeLimit = Math.max(1, Math.min(2000, limit));
    const all = routeLogModule.readRouteLog(repoRoot);
    return json(res, {
      total: all.length,
      decisions: all.slice(-safeLimit).reverse(),
    });
  });

  // ── GET /api/symphonee/route-log/stats ──────────────────────────────────
  // Aggregate recall-vs-escalate picture: escalation rate, escalation reasons,
  // per-intent split, plus confidence + latency means per branch. The honest
  // "what is the conductor actually choosing?" view before we deepen routing.
  addRoute('GET', '/api/symphonee/route-log/stats', (req, res) => {
    return json(res, routeLogModule.getStats(repoRoot));
  });

  // ── GET /api/symphonee/intent ───────────────────────────────────────────
  addRoute('GET', '/api/symphonee/intent', (req, res) => {
    return json(res, { intent: intent.get(), pendingEvidence: intent.pendingCount() });
  });

  // ── POST /api/symphonee/intent/notify ───────────────────────────────────
  // Caller passes { kind, detail, repo, file, source }. Manager debounces
  // and triggers a recompute via the planner.
  addRoute('POST', '/api/symphonee/intent/notify', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.kind) return json(res, { error: 'kind required' }, 400);
    intent.notify({
      kind: String(body.kind).slice(0, 64),
      detail: body.detail ? String(body.detail).slice(0, 400) : null,
      repo: body.repo || null,
      file: body.file || null,
      source: body.source || 'manual',
    });
    return json(res, { ok: true, pending: intent.pendingCount() });
  });

  // ── POST /api/symphonee/intent/recompute (force) ────────────────────────
  addRoute('POST', '/api/symphonee/intent/recompute', async (req, res) => {
    const next = await intent.forceRecompute();
    return json(res, { ok: true, intent: next || intent.get() });
  });

  // ── POST /api/symphonee/intent/pause | resume ───────────────────────────
  addRoute('POST', '/api/symphonee/intent/pause', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    intent.pause(body.reason || 'manual');
    return json(res, { ok: true, paused: true });
  });
  addRoute('POST', '/api/symphonee/intent/resume', async (req, res) => {
    intent.resume();
    return json(res, { ok: true, paused: false });
  });

  // ── GET /api/symphonee/status ───────────────────────────────────────────
  addRoute('GET', '/api/symphonee/status', async (req, res) => {
    let setup = null;
    try { setup = await ollamaSetup.detectBrainSetup(); } catch (_) {}
    return json(res, {
      triageModel: planner.TRIAGE_MODEL,
      reasoningModel: planner.REASONING_MODEL,
      escalationThreshold: planner.ESCALATION_THRESHOLD,
      knownIntents: planner.KNOWN_INTENTS,
      intent: intent.get(),
      decisionCount: decisionLog.length,
      setup,
    });
  });

  // ── POST /api/symphonee/outcome ─────────────────────────────────────────
  // Attach an outcome to a previously-logged decision. Body:
  //   { decisionId, outcome: validated|contradicted|corrected|unused, detail? }
  // The brain looks up the decision (in the in-memory ring buffer) to
  // snapshot its intent + primary_cli at outcome-record time. If the
  // decision has aged out, we accept the outcome but record null snapshot
  // fields - the stats aggregator handles that cleanly.
  addRoute('POST', '/api/symphonee/outcome', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = body.decisionId;
    const outcome = body.outcome;
    if (!id) return json(res, { error: 'decisionId required' }, 400);
    if (!outcome || !outcomesModule.VALID_OUTCOMES.has(outcome)) {
      return json(res, {
        error: 'outcome must be one of ' + Array.from(outcomesModule.VALID_OUTCOMES).join(' | '),
      }, 400);
    }
    const dec = findDecision(id);
    const snapshot = {
      intent: dec && dec.decision && dec.decision.intent || null,
      primaryCli: dec && dec.decision && dec.decision.primary_cli || null,
      detail: body.detail || null,
    };
    const ok = outcomesModule.recordOutcome(repoRoot, id, outcome, snapshot);
    if (!ok) return json(res, { error: 'failed to record outcome' }, 500);
    if (broadcast) broadcast({ type: 'symphonee-outcome', payload: { decisionId: id, outcome, snapshot } });
    return json(res, { ok: true, decisionId: id, outcome, snapshot, decisionFound: !!dec });
  });

  // ── GET /api/symphonee/outcomes ─────────────────────────────────────────
  // Raw outcome stream, newest first.
  addRoute('GET', '/api/symphonee/outcomes', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const safeLimit = Math.max(1, Math.min(500, limit));
    const all = outcomesModule.readOutcomes(repoRoot);
    return json(res, {
      total: all.length,
      outcomes: all.slice(-safeLimit).reverse(),
    });
  });

  // ── GET /api/symphonee/outcomes/stats ───────────────────────────────────
  // Aggregated win-rates per intent / per cli / per (intent, cli).
  addRoute('GET', '/api/symphonee/outcomes/stats', (req, res) => {
    const stats = outcomesModule.getStats(repoRoot);
    return json(res, { ...stats, minSamplesForRate: outcomesModule.MIN_SAMPLES_FOR_STATS });
  });

  // ── GET /api/symphonee/setup/check ──────────────────────────────────────
  // First-PC onboarding: does this machine have everything the brain
  // needs to actually work? Returns { ollamaInstalled, ollamaRunning,
  // triageModelInstalled, reasoningModelInstalled, missing, hint, ready }.
  addRoute('GET', '/api/symphonee/setup/check', async (req, res) => {
    try {
      const r = await ollamaSetup.detectBrainSetup();
      return json(res, r);
    } catch (err) {
      return json(res, { ready: false, error: err.message }, 500);
    }
  });

  // ── POST /api/symphonee/setup/pull ──────────────────────────────────────
  // Pull a brain model on demand. Body: { model? } (defaults to the
  // reasoning model, the only large one users actually have to opt into).
  // Streams progress via the ollama-pull mind-update WebSocket events.
  addRoute('POST', '/api/symphonee/setup/pull', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const model = body.model || ollamaSetup.DEFAULT_REASONING_MODEL;
    // Fire-and-forget so the HTTP request returns immediately; the UI
    // watches the WS stream for progress chunks.
    json(res, { ok: true, started: true, model });
    Promise.resolve().then(() => ollamaSetup.pullBrainModel({ model, broadcast }))
      .then((r) => {
        if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'ollama-pull', model, status: r.ok ? 'success' : 'error', error: r.error || null } });
      })
      .catch((err) => {
        if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'ollama-pull', model, status: 'error', error: err.message } });
      });
  });

  // ── GET /api/symphonee/perf ─────────────────────────────────────────────
  // Rolling latency p50/p95/max + cache hit/miss counters per faculty.
  // The honest answer to "is the brain making Symphonee slower" -- with
  // numbers, not vibes.
  addRoute('GET', '/api/symphonee/perf', (req, res) => {
    return json(res, perfModule.snapshot());
  });

  // ── POST /api/symphonee/perf/reset ──────────────────────────────────────
  addRoute('POST', '/api/symphonee/perf/reset', (req, res) => {
    perfModule.reset();
    return json(res, { ok: true });
  });

  // ── GET /api/symphonee/prompt ───────────────────────────────────────────
  // Returns the active routing-rules block + source (default | override).
  addRoute('GET', '/api/symphonee/prompt', (req, res) => {
    const cur = promptStoreModule.loadRules(repoRoot);
    return json(res, cur);
  });

  // ── GET /api/symphonee/prompt/history ───────────────────────────────────
  addRoute('GET', '/api/symphonee/prompt/history', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    return json(res, { history: promptStoreModule.readHistory(repoRoot, { limit }) });
  });

  // ── POST /api/symphonee/self-iterate ────────────────────────────────────
  // Propose a revised rules block from observed outcomes. Never auto-applies.
  addRoute('POST', '/api/symphonee/self-iterate', async (req, res) => {
    try {
      const r = await selfIterateModule.propose(repoRoot);
      if (broadcast && r.ok) broadcast({ type: 'symphonee-self-iterate', payload: { summary: r.proposal && r.proposal.summary, totalSamples: r.totalSamples } });
      return json(res, r);
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  });

  // ── POST /api/symphonee/self-iterate/accept ─────────────────────────────
  // Apply a proposed rules block. Body: { rules, note? }. Previous state
  // goes to prompt-store history so revert works.
  addRoute('POST', '/api/symphonee/self-iterate/accept', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.rules) return json(res, { error: 'rules required' }, 400);
    const r = selfIterateModule.accept(repoRoot, body.rules, { note: body.note || null });
    if (!r.ok) return json(res, r, 400);
    if (broadcast) broadcast({ type: 'symphonee-self-iterate', payload: { event: 'accepted' } });
    return json(res, r);
  });

  // ── POST /api/symphonee/self-iterate/revert ─────────────────────────────
  // One step back in rules history.
  addRoute('POST', '/api/symphonee/self-iterate/revert', async (req, res) => {
    const r = selfIterateModule.revert(repoRoot);
    if (broadcast) broadcast({ type: 'symphonee-self-iterate', payload: { event: 'reverted', source: r.source } });
    return json(res, r);
  });

  // ── POST /api/symphonee/answer ──────────────────────────────────────────
  // The local-first answer pipeline. Plans, tries Mind, tries local gemma,
  // then signals "escalate" if a frontier CLI is the right tool.
  // Returns { source, answer?, decision, citedNodeIds?, tookMs }.
  addRoute('POST', '/api/symphonee/answer', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const input = body.input || body.prompt || body.text;
    if (!input || typeof input !== 'string') {
      return json(res, { error: 'input required' }, 400);
    }
    const ui = getUiContext ? getUiContext() : {};
    const current = intent.get();
    try {
      const result = await answerModule.answer(input, {
        repoRoot,
        space: (ctx.getUiContext && ctx.getUiContext().activeSpace) || (ui && ui.activeSpace) || '_global',
        intent: current,
        ui,
      });
      if (broadcast && result && result.source) {
        broadcast({ type: 'symphonee-answer', payload: { source: result.source, intent: result.decision && result.decision.intent, tookMs: result.tookMs } });
      }
      return json(res, result);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // ── POST /api/symphonee/synthesize ──────────────────────────────────────
  // Read recent sessions from .symphonee/sequences.jsonl, cluster by shape,
  // and ask gemma to draft a recipe per mature cluster. Returns drafts
  // (some accepted, some skipped with a reason). Explicit on-demand call;
  // nothing autonomous about this.
  addRoute('POST', '/api/symphonee/synthesize', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const days = Number.isFinite(body.days) ? body.days : 30;
    const minClusterSize = Number.isFinite(body.minClusterSize) ? body.minClusterSize : 3;
    const maxDrafts = Number.isFinite(body.maxDrafts) ? body.maxDrafts : 5;
    try {
      const r = await synthesizeModule.synthesize(repoRoot, { days, minClusterSize, maxDrafts });
      return json(res, r);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  });

  // ── POST /api/symphonee/synthesize/accept ───────────────────────────────
  // Materialize a draft as recipes/<slug>.md. Body: { draft }. Refuses to
  // overwrite an existing file.
  addRoute('POST', '/api/symphonee/synthesize/accept', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.draft) return json(res, { error: 'draft required' }, 400);
    const file = synthesizeModule.acceptDraft(repoRoot, body.draft);
    if (!file) return json(res, { error: 'could not materialize draft (already exists or malformed)' }, 409);
    return json(res, { ok: true, file });
  });

  // ── GET /api/symphonee/sequences ────────────────────────────────────────
  // Inspect recent recorded events. Read-only debug surface.
  addRoute('GET', '/api/symphonee/sequences', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const days = parseInt(url.searchParams.get('days') || '7', 10);
    const sess = sequencesModule.getRecentSessions(repoRoot, { days: Math.max(1, days) });
    return json(res, {
      sessions: sess.slice(0, 50).map(s => ({
        repo: s.repo,
        startTs: s.startTs,
        endTs: s.endTs,
        events: s.events.length,
        kinds: [...new Set(s.events.map(e => e.kind))],
      })),
      total: sess.length,
    });
  });

  // ── GET /api/symphonee/instructions ─────────────────────────────────────
  addRoute('GET', '/api/symphonee/instructions', (req, res) => {
    const p = path.join(__dirname, 'instructions.md');
    try {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(fs.readFileSync(p));
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });

  // Public surface the rest of server.js needs to wire into event paths.
  // plan(input) is what the orchestrator calls when no CLI was specified -
  // the brain picks. We log the decision here so the audit trail captures
  // orchestrator-driven calls the same as /api/symphonee/think.
  async function plan(input, opts = {}) {
    if (!input || typeof input !== 'string') {
      return { ok: false, error: 'input required', decision: null };
    }
    const ui = getUiContext ? getUiContext() : {};
    const current = intent.get();
    const startedAt = Date.now();
    const result = await planner.planRoute(input, { ui, intent: current, outcomeHints: getOutcomeHints(), repoRoot });
    const tookMs = Date.now() - startedAt;
    const logged = logDecision({
      input: input.slice(0, 240),
      ok: result.ok,
      stage: result.stage,
      escalated: result.escalated,
      forceEscalated: result.forceEscalated,
      triageConfidence: result.triageConfidence,
      triagePatches: result.triagePatches,
      patches: result.patches,
      model: result.model,
      triageModel: result.triageModel,
      decision: result.decision,
      error: result.error,
      tookMs,
      source: opts.source || 'plan',
    });
    if (broadcast) {
      broadcast({ type: 'symphonee-plan', payload: { ...logged, tookMs } });
    }
    return { ...result, tookMs, decisionId: logged.id };
  }

  // Public surface: the in-process answer() entrypoint the orchestrator
  // calls when /spawn has no explicit cli. Wraps answerModule.answer with
  // the brain's live intent + UI context + outcome hints so callers do
  // not have to reconstruct that themselves.
  async function answer(input, opts = {}) {
    const ui = getUiContext ? getUiContext() : {};
    return answerModule.answer(input, {
      repoRoot,
      space: (ui && ui.activeSpace) || '_global',
      intent: intent.get(),
      ui,
      outcomeHints: getOutcomeHints(),
      ...opts,
    });
  }

  return {
    notifyIntent: (ev) => intent.notify(ev),
    getIntent: () => intent.get(),
    forceRecomputeIntent: () => intent.forceRecompute(),
    plan,
    answer,
    synthesize: (o) => synthesizeModule.synthesize(repoRoot, o || {}),
    acceptDraft: (d) => synthesizeModule.acceptDraft(repoRoot, d),
    recordEvent: (ev) => sequencesModule.recordEvent(repoRoot, ev),
    proposeRulesEdit: () => selfIterateModule.propose(repoRoot),
    acceptRulesEdit: (rules, opts) => selfIterateModule.accept(repoRoot, rules, opts || {}),
    revertRulesEdit: () => selfIterateModule.revert(repoRoot),
    getRules: () => promptStoreModule.loadRules(repoRoot),
  };
}

module.exports = { mountBrain };
