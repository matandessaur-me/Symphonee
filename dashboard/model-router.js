/**
 * Symphonee -- Model Router
 *
 * Given a task intent + availability signals, recommend the best
 * (cli, model) pair. Consulted by graph-runs, orchestrator recipes, and
 * any script that wants to stop hardcoding model choices.
 *
 * The router filters to what the user actually has access to:
 *   - CLIs enabled in OrchestrateCliList (if orchestration mode is on)
 *   - CLIs whose required API key is set (for models behind an API key)
 *
 * It never invents availability. If nothing matches, it returns
 * { cli: null, model: null, reasoning: '...' } so callers can degrade.
 *
 * Data is from research as of April 2026 (see gap analysis brief).
 */

const path = require('path');
const fs = require('fs');

// ── Catalog ─────────────────────────────────────────────────────────────────
// tier: fast | balanced | deep
// cost: relative 0-5 (0 = free tier / open, 5 = most expensive)
// ctx: context window in tokens
// webSearch: 'native' | 'google' | false
// agentic: fair | good | excellent (long-horizon autonomy)
// specialty: optional focus area
// requiresKey: env var name if the model only works with a user-supplied API key
const CATALOG = {
  claude: {
    provider: 'Anthropic',
    models: {
      'haiku-4-5': { id: 'claude-haiku-4-5', tier: 'fast', cost: 1, ctx: 200000, agentic: 'fair' },
      'sonnet-4-6': { id: 'claude-sonnet-4-6', tier: 'balanced', cost: 3, ctx: 1000000, agentic: 'good' },
      'opus-4-6': { id: 'claude-opus-4-6', tier: 'deep', cost: 5, ctx: 1000000, agentic: 'excellent' },
      'opusplan': { id: 'claude-opusplan', tier: 'deep', cost: 4, ctx: 1000000, agentic: 'excellent', hybrid: true,
        note: 'Auto-switches: Opus for planning, Sonnet for execution.' },
    },
  },
  codex: {
    provider: 'OpenAI',
    models: {
      'gpt-5.4-mini': { id: 'gpt-5.4-mini', tier: 'fast', cost: 1, webSearch: 'native', agentic: 'good',
        note: 'Built for parallelizable low-complexity work.' },
      'gpt-5.4': { id: 'gpt-5.4', tier: 'balanced', cost: 3, webSearch: 'native', agentic: 'excellent',
        note: 'Flagship. Best long-horizon autonomy + native web search.' },
      'gpt-5.3-codex': { id: 'gpt-5.3-codex', tier: 'deep', cost: 3, webSearch: 'native', agentic: 'excellent',
        specialty: 'coding' },
      'gpt-5.3-codex-spark': { id: 'gpt-5.3-codex-spark', tier: 'fast', cost: 1, webSearch: 'native', agentic: 'fair',
        note: '1000+ tok/s, real-time coding.' },
    },
  },
  gemini: {
    provider: 'Google',
    models: {
      'gemini-3-flash': { id: 'gemini-3-flash', tier: 'fast', cost: 0, ctx: 1000000, webSearch: 'google', agentic: 'good',
        note: 'Free tier. 78% SWE-bench. Faster than Pro.' },
      'gemini-3-pro': { id: 'gemini-3-pro', tier: 'deep', cost: 2, ctx: 2000000, webSearch: 'google', agentic: 'good',
        requiresKey: 'GEMINI_API_KEY', note: 'Paid tier only (March 2026+).' },
    },
  },
  copilot: {
    provider: 'GitHub',
    models: {
      'default': { id: 'copilot', tier: 'balanced', cost: 2, agentic: 'good', specialty: 'github',
        note: 'Native PR/issue/repo workflow integration.' },
    },
  },
  grok: {
    provider: 'xAI',
    models: {
      'grok-4-fast': { id: 'grok-4-fast', tier: 'fast', cost: 1, agentic: 'good', specialty: 'x-social',
        requiresKey: 'XAI_API_KEY', experimental: true,
        note: 'No official xAI CLI as of April 2026. Community CLI only. Unique edge: live X/social context.' },
      'grok-4-20': { id: 'grok-4-20', tier: 'deep', cost: 3, ctx: 2000000, agentic: 'good',
        requiresKey: 'XAI_API_KEY', experimental: true },
    },
  },
  qwen: {
    provider: 'Alibaba',
    models: {
      'qwen3-coder-flash': { id: 'qwen3-coder-flash', tier: 'fast', cost: 1, ctx: 256000, agentic: 'fair', specialty: 'coding',
        requiresKey: 'DASHSCOPE_API_KEY',
        note: 'Fast Qwen3-Coder variant. Open-weights family, cheap via DashScope.' },
      'qwen3-coder-plus': { id: 'qwen3-coder-plus', tier: 'balanced', cost: 2, ctx: 1000000, agentic: 'good', specialty: 'coding',
        requiresKey: 'DASHSCOPE_API_KEY',
        note: 'Flagship Qwen3-Coder. Strong on repo-scale code edits.' },
      'qwen3-max': { id: 'qwen3-max', tier: 'deep', cost: 3, ctx: 256000, agentic: 'good',
        requiresKey: 'DASHSCOPE_API_KEY',
        note: 'General-purpose flagship.' },
    },
  },
};

// ── Intent -> preference matrix ─────────────────────────────────────────────
// Higher weight means stronger preference.
const INTENTS = {
  'quick-summary': {
    description: 'Short text output: summary, classify, haiku, one-paragraph answer.',
    prefer: [
      { cli: 'claude', model: 'haiku-4-5', weight: 10 },
      { cli: 'codex', model: 'gpt-5.4-mini', weight: 9 },
      { cli: 'gemini', model: 'gemini-3-flash', weight: 8 },
      { cli: 'qwen', model: 'qwen3-coder-flash', weight: 6 },
    ],
  },
  'deep-code': {
    description: 'Complex refactor, debugging, architecture. Needs best reasoning.',
    prefer: [
      { cli: 'claude', model: 'opus-4-6', weight: 10 },
      { cli: 'codex', model: 'gpt-5.3-codex', weight: 9 },
      { cli: 'claude', model: 'sonnet-4-6', weight: 7 },
      { cli: 'qwen', model: 'qwen3-coder-plus', weight: 6 },
    ],
  },
  'plan-and-implement': {
    description: 'Multi-step task: reason about approach, then write the code.',
    prefer: [
      { cli: 'claude', model: 'opusplan', weight: 10 },
      { cli: 'codex', model: 'gpt-5.4', weight: 8 },
      { cli: 'claude', model: 'opus-4-6', weight: 7 },
    ],
  },
  'long-autonomy': {
    description: 'Multi-hour agentic work. Needs persistence + strong self-correction.',
    prefer: [
      { cli: 'codex', model: 'gpt-5.4', weight: 10 },
      { cli: 'claude', model: 'opus-4-6', weight: 8 },
    ],
  },
  'web-research': {
    description: 'Needs current info from the open web.',
    prefer: [
      { cli: 'codex', model: 'gpt-5.4', weight: 10, reason: 'native web search' },
      { cli: 'gemini', model: 'gemini-3-pro', weight: 8, reason: 'Google search tool' },
      { cli: 'gemini', model: 'gemini-3-flash', weight: 6 },
    ],
  },
  'web-research-cheap': {
    description: 'Light web lookup: current price, docs, changelog.',
    prefer: [
      { cli: 'codex', model: 'gpt-5.4-mini', weight: 10 },
      { cli: 'gemini', model: 'gemini-3-flash', weight: 8 },
    ],
  },
  'pr-review': {
    description: 'Review or comment on GitHub PRs and issues.',
    prefer: [
      { cli: 'copilot', model: 'default', weight: 10 },
      { cli: 'claude', model: 'sonnet-4-6', weight: 7 },
    ],
  },
  'social-live': {
    description: 'Live X/Twitter or social-media context.',
    prefer: [
      { cli: 'grok', model: 'grok-4-fast', weight: 10 },
      { cli: 'codex', model: 'gpt-5.4', weight: 5, reason: 'fallback via web search' },
    ],
  },
  'parallel-fanout': {
    description: 'One of N parallel workers in a fan-out. Optimize for cost + speed.',
    prefer: [
      { cli: 'codex', model: 'gpt-5.4-mini', weight: 10 },
      { cli: 'gemini', model: 'gemini-3-flash', weight: 9 },
      { cli: 'claude', model: 'haiku-4-5', weight: 8 },
      { cli: 'qwen', model: 'qwen3-coder-flash', weight: 7 },
    ],
  },
  'large-context': {
    description: 'Input exceeds 200k tokens (massive repo, long transcript).',
    prefer: [
      { cli: 'gemini', model: 'gemini-3-pro', weight: 10, reason: '2M ctx' },
      { cli: 'claude', model: 'opus-4-6', weight: 9, reason: '1M ctx' },
      { cli: 'claude', model: 'sonnet-4-6', weight: 8, reason: '1M ctx' },
    ],
  },
};

// ── Availability ────────────────────────────────────────────────────────────
function loadConfig(configPath) {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; }
}

function availableClis(cfg) {
  // Orchestration allowlist trumps everything. If orchestration mode is off,
  // assume the user's primary CLI is available (they run Symphonee alone).
  if (cfg.OrchestrateMode === true) {
    const list = Array.isArray(cfg.OrchestrateCliList) ? cfg.OrchestrateCliList : [];
    return new Set(list);
  }
  // Orchestration off: assume all catalog CLIs available (user will tell us if not).
  // DefaultCli is always available.
  const s = new Set(Object.keys(CATALOG));
  return s;
}

function modelAvailable(cli, modelKey, cfg) {
  const entry = CATALOG[cli] && CATALOG[cli].models[modelKey];
  if (!entry) return false;
  if (entry.requiresKey) {
    const keys = cfg.AiApiKeys || {};
    if (!keys[entry.requiresKey]) return false;
  }
  return true;
}

// ── Recommend ───────────────────────────────────────────────────────────────
function recommend({ intent, contextTokens, budget, configPath }) {
  const cfg = loadConfig(configPath);
  const allowedClis = availableClis(cfg);

  // Auto-promote intent based on context size.
  const effectiveIntent = (contextTokens && contextTokens > 200000) ? 'large-context' : intent;

  const spec = INTENTS[effectiveIntent];
  if (!spec) {
    return { cli: null, model: null, reasoning: `Unknown intent: ${intent}. Known intents: ${Object.keys(INTENTS).join(', ')}.` };
  }

  // Walk preferences in order, pick the first one that is available.
  for (const pref of spec.prefer) {
    if (!allowedClis.has(pref.cli)) continue;
    if (!modelAvailable(pref.cli, pref.model, cfg)) continue;
    if (budget === 'cheap' && CATALOG[pref.cli].models[pref.model].cost > 2) continue;
    if (budget === 'premium' && CATALOG[pref.cli].models[pref.model].cost < 3) continue;
    const meta = CATALOG[pref.cli].models[pref.model];
    const reason = pref.reason || spec.description;
    return {
      cli: pref.cli,
      model: meta.id,
      modelKey: pref.model,
      reasoning: `intent=${effectiveIntent}; picked ${pref.cli}/${pref.model} (${reason}); budget=${budget || 'default'}`,
      meta,
    };
  }

  // Nothing available for this intent. Return a fallback that's clearly marked.
  const fallbackCli = cfg.DefaultCli || Array.from(allowedClis)[0];
  return {
    cli: fallbackCli || null,
    model: null,
    reasoning: `No preferred model available for intent=${effectiveIntent}. Fallback to default cli=${fallbackCli || 'none'}. Check OrchestrateCliList and AiApiKeys in config.`,
    fallback: true,
  };
}

// ── Public catalog view (sanitized, no secrets) ─────────────────────────────
function publicCatalog(configPath) {
  const cfg = loadConfig(configPath);
  const allowed = availableClis(cfg);
  const out = {};
  for (const [cli, clientDef] of Object.entries(CATALOG)) {
    const models = {};
    for (const [key, meta] of Object.entries(clientDef.models)) {
      models[key] = {
        ...meta,
        available: allowed.has(cli) && modelAvailable(cli, key, cfg),
        cliEnabled: allowed.has(cli),
      };
    }
    out[cli] = { provider: clientDef.provider, models };
  }
  return { catalog: out, intents: INTENTS };
}

module.exports = { CATALOG, INTENTS, recommend, publicCatalog, availableClis, modelAvailable };
