/**
 * Symphonee brain - the reasoning layer that sits above Mind.
 *
 * Mind is memory. Brain is the loop that reads memory, classifies inputs,
 * picks tools, and (eventually) acts. CLIs become tools the brain dispatches
 * via the orchestrator; the brain itself never replaces the frontier models.
 *
 * Endpoints:
 *   POST /api/symphonee/think           - planner front door (smart by default)
 *   GET  /api/symphonee/intent          - current intent state
 *   POST /api/symphonee/intent/notify   - push evidence (file edit, drawer, etc)
 *   POST /api/symphonee/intent/recompute- force a recompute with pending evidence
 *   POST /api/symphonee/intent/pause    - pause auto-recompute
 *   POST /api/symphonee/intent/resume   - resume auto-recompute
 *   GET  /api/symphonee/status          - brain config + planner mode
 *   GET  /api/symphonee/instructions    - markdown doc for CLIs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const intentModule = require('./intent');
const planner = require('./planner');

// Two modes only:
//   smart  - brain observes, maintains intent, logs decisions when asked.
//            Does NOT override the orchestrator's CLI selection. Default.
//   active - brain also fills in the missing cli when the caller of
//            /api/orchestrator/spawn does not specify one.
// Legacy values ("off", "shadow") map to "smart" on read so existing
// config files keep working without an explicit migration.
const MODE_SMART = 'smart';
const LEGACY_MODE_ALIASES = { off: MODE_SMART, shadow: MODE_SMART };
const MODE_ACTIVE = 'active';
const VALID_MODES = new Set([MODE_SMART, MODE_ACTIVE]);

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
  const { repoRoot, broadcast, getUiContext, getConfig } = ctx;

  function plannerMode() {
    try {
      const cfg = getConfig ? (getConfig() || {}) : {};
      const raw = (cfg.SymphoneeBrain && cfg.SymphoneeBrain.plannerMode) || MODE_SMART;
      // Map legacy values ("off", "shadow") to the closest current mode so
      // existing configs do not need an explicit migration.
      const m = LEGACY_MODE_ALIASES[raw] || raw;
      return VALID_MODES.has(m) ? m : MODE_SMART;
    } catch (_) {
      return MODE_SMART;
    }
  }

  // Singleton intent manager bound to onRecompute -> planner.recomputeIntent
  const intent = intentModule.createIntentManager({
    repoRoot,
    broadcast,
    getUiContext,
    onRecompute: async ({ ui, current, evidence }) => {
      return planner.recomputeIntent({ ui, current, evidence });
    },
  });

  // Planning-decision log (in-memory ring buffer). Shadow mode writes here
  // so the user can audit what the planner WOULD have done before flipping
  // mode to active.
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
    const mode = plannerMode();
    const ui = getUiContext ? getUiContext() : {};
    const current = intent.get();
    const startedAt = Date.now();
    const plan = await planner.planRoute(input, { ui, intent: current });
    const tookMs = Date.now() - startedAt;
    const entry = {
      mode,
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
    // In smart mode we never dispatch; we only record the decision so the
    // user can audit whether the planner is making good calls. In active
    // mode the caller (orchestrator, UI) is responsible for honoring
    // plan.decision.needed_tools.
    if (broadcast) {
      broadcast({ type: 'symphonee-plan', payload: entry });
    }
    return json(res, { ...plan, mode, tookMs });
  });

  // ── GET /api/symphonee/decisions ────────────────────────────────────────
  addRoute('GET', '/api/symphonee/decisions', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const safeLimit = Math.max(1, Math.min(DECISION_LOG_MAX, limit));
    return json(res, {
      mode: plannerMode(),
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
      mode: plannerMode(),
      triageModel: planner.TRIAGE_MODEL,
      reasoningModel: planner.REASONING_MODEL,
      escalationThreshold: planner.ESCALATION_THRESHOLD,
      knownIntents: planner.KNOWN_INTENTS,
      intent: intent.get(),
      decisionCount: decisionLog.length,
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
  // plan(input) is what the orchestrator calls when active mode is on and
  // no CLI was specified - lets the brain pick. We also log the decision
  // here so the audit trail captures orchestrator-driven calls the same as
  // /api/symphonee/think.
  async function plan(input, opts = {}) {
    if (!input || typeof input !== 'string') {
      return { ok: false, error: 'input required', decision: null };
    }
    const mode = plannerMode();
    const ui = getUiContext ? getUiContext() : {};
    const current = intent.get();
    const startedAt = Date.now();
    const result = await planner.planRoute(input, { ui, intent: current });
    const tookMs = Date.now() - startedAt;
    logDecision({
      mode,
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
      broadcast({ type: 'symphonee-plan', payload: { ...result, mode, tookMs, source: opts.source || 'plan' } });
    }
    return { ...result, mode, tookMs };
  }

  return {
    notifyIntent: (ev) => intent.notify(ev),
    getIntent: () => intent.get(),
    plannerMode,
    forceRecomputeIntent: () => intent.forceRecompute(),
    plan,
  };
}

module.exports = { mountBrain, MODE_SMART, MODE_ACTIVE };
