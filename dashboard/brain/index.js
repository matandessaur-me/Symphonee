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
  // routed and why.
  const decisionLog = [];
  const DECISION_LOG_MAX = 200;
  function logDecision(entry) {
    decisionLog.push({ at: new Date().toISOString(), ...entry });
    if (decisionLog.length > DECISION_LOG_MAX) decisionLog.shift();
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
    const plan = await planner.planRoute(input, { ui, intent: current });
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
    logDecision(entry);
    if (broadcast) {
      broadcast({ type: 'symphonee-plan', payload: entry });
    }
    return json(res, { ...plan, tookMs });
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
  addRoute('GET', '/api/symphonee/status', (req, res) => {
    return json(res, {
      triageModel: planner.TRIAGE_MODEL,
      reasoningModel: planner.REASONING_MODEL,
      escalationThreshold: planner.ESCALATION_THRESHOLD,
      knownIntents: planner.KNOWN_INTENTS,
      intent: intent.get(),
      decisionCount: decisionLog.length,
    });
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
    const result = await planner.planRoute(input, { ui, intent: current });
    const tookMs = Date.now() - startedAt;
    logDecision({
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
      broadcast({ type: 'symphonee-plan', payload: { ...result, tookMs, source: opts.source || 'plan' } });
    }
    return { ...result, tookMs };
  }

  return {
    notifyIntent: (ev) => intent.notify(ev),
    getIntent: () => intent.get(),
    forceRecomputeIntent: () => intent.forceRecompute(),
    plan,
    synthesize: (o) => synthesizeModule.synthesize(repoRoot, o || {}),
    acceptDraft: (d) => synthesizeModule.acceptDraft(repoRoot, d),
    recordEvent: (ev) => sequencesModule.recordEvent(repoRoot, ev),
  };
}

module.exports = { mountBrain };
