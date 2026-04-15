/**
 * Symphonee -- Permission Engine
 *
 * Actions the engine evaluates:
 *   { type: 'cmd',    value: 'git push origin HEAD' }
 *   { type: 'path',   value: 'src/index.js', op: 'write' | 'read' }
 *   { type: 'api',    value: 'POST /api/github/pulls/comment' }
 *   { type: 'plugin', value: 'builderio:publish' }
 *   { type: 'cli',    value: 'claude:spawn' }
 *   { type: 'tool',   value: 'Bash' | 'Edit' | 'WebFetch' ... }
 *
 * Rules are strings of form "<type>:<match>" where <match> supports glob '*'.
 * Mode-based defaults fire when no rule matches.
 *
 * Returns: { decision: 'allow'|'ask'|'deny', matchedRule, reason, mode }
 */

const fs = require('fs');
const path = require('path');

const MODES = ['review', 'edit', 'trusted', 'bypass'];
const DEFAULT_MODE = 'edit';

// Built-in rule sets per mode. Explicit rules in settings override these.
const MODE_DEFAULTS = {
  review: {
    deny: [
      'tool:Edit', 'tool:Write', 'tool:MultiEdit',
      'cmd:git push*', 'cmd:git reset --hard*', 'cmd:rm -rf*',
      'path:*|op=write',
      'api:POST *', 'api:PUT *', 'api:DELETE *', 'api:PATCH *',
      'plugin:*:publish', 'plugin:*:create', 'plugin:*:update', 'plugin:*:delete',
      'cli:*:spawn',
    ],
    ask: [],
    allow: ['tool:Read', 'tool:Grep', 'tool:Glob', 'tool:LS', 'path:*|op=read', 'api:GET *'],
  },
  edit: {
    deny: ['cmd:rm -rf /*'],
    ask: [
      'cmd:git push*', 'cmd:git reset --hard*', 'cmd:git checkout --*',
      'cmd:npm publish*', 'cmd:yarn publish*',
      'api:POST /api/github/pulls/comment', 'api:POST /api/github/pulls/review',
      'api:POST /api/workitems/*/comments',
      'api:POST /api/workitems', 'api:PATCH /api/workitems/*',
      'plugin:*:publish', 'plugin:*:delete',
      'cli:*:spawn',
    ],
    allow: ['tool:*', 'path:*', 'api:GET *', 'cmd:*'],
  },
  trusted: {
    deny: [],
    ask: ['cmd:npm publish*', 'cmd:yarn publish*', 'api:POST /api/github/pulls/review'],
    allow: ['tool:*', 'path:*', 'api:*', 'cmd:*', 'plugin:*', 'cli:*'],
  },
  bypass: { deny: [], ask: [], allow: ['*'] },
};

// ── Pattern matching ────────────────────────────────────────────────────────
function compilePattern(rule) {
  // rule = "type:match" or "type:match|op=X"
  const [body, ...mods] = rule.split('|');
  const colon = body.indexOf(':');
  if (colon < 0) return { type: '*', match: body, mods: parseMods(mods) };
  return {
    type: body.slice(0, colon),
    match: body.slice(colon + 1),
    mods: parseMods(mods),
  };
}

function parseMods(mods) {
  const out = {};
  for (const m of mods) {
    const eq = m.indexOf('=');
    if (eq > 0) out[m.slice(0, eq)] = m.slice(eq + 1);
  }
  return out;
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function matches(action, pattern) {
  const p = typeof pattern === 'string' ? compilePattern(pattern) : pattern;
  if (p.type !== '*' && p.type !== action.type) return false;
  if (p.mods.op && action.op && p.mods.op !== action.op) return false;
  const re = globToRegex(p.match);
  return re.test(action.value || '');
}

// ── Evaluation ──────────────────────────────────────────────────────────────
function evaluate(action, settings = {}, ctx = {}) {
  const mode = MODES.includes(settings.mode) ? settings.mode : DEFAULT_MODE;
  const explicit = {
    deny: settings.deny || [],
    ask: settings.ask || [],
    allow: settings.allow || [],
  };
  const defaults = MODE_DEFAULTS[mode];

  // Trusted mode: in a worktree, promote everything to allow.
  const effective = mode === 'trusted' && !ctx.worktree
    ? MODE_DEFAULTS.edit
    : defaults;

  // Precedence: explicit deny > explicit ask > explicit allow > default deny > default ask > default allow
  const order = [
    ['deny', explicit.deny],
    ['ask', explicit.ask],
    ['allow', explicit.allow],
    ['deny', effective.deny],
    ['ask', effective.ask],
    ['allow', effective.allow],
  ];

  for (const [decision, rules] of order) {
    for (const rule of rules) {
      if (matches(action, rule)) {
        return { decision, matchedRule: rule, reason: `matched ${decision} rule`, mode };
      }
    }
  }
  // No match at all: ask (conservative default).
  return { decision: 'ask', matchedRule: null, reason: 'no rule matched, asking', mode };
}

// ── Settings load/save ──────────────────────────────────────────────────────
function loadSettings(configJsonPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
    const p = cfg.Permissions || {};
    return {
      mode: MODES.includes(p.mode) ? p.mode : DEFAULT_MODE,
      allow: Array.isArray(p.allow) ? p.allow : [],
      ask: Array.isArray(p.ask) ? p.ask : [],
      deny: Array.isArray(p.deny) ? p.deny : [],
    };
  } catch (_) {
    return { mode: DEFAULT_MODE, allow: [], ask: [], deny: [] };
  }
}

function saveSettings(configJsonPath, patch) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configJsonPath, 'utf8')); } catch (_) {}
  cfg.Permissions = { ...(cfg.Permissions || {}), ...patch };
  // Normalize mode
  if (!MODES.includes(cfg.Permissions.mode)) cfg.Permissions.mode = DEFAULT_MODE;
  for (const k of ['allow', 'ask', 'deny']) {
    if (!Array.isArray(cfg.Permissions[k])) cfg.Permissions[k] = [];
  }
  fs.mkdirSync(path.dirname(configJsonPath), { recursive: true });
  if (typeof global.__markConfigSelfWrite === 'function') global.__markConfigSelfWrite();
  fs.writeFileSync(configJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg.Permissions;
}

// ── Promote an approval into a persistent rule ──────────────────────────────
function promoteRule(configJsonPath, rule, bucket = 'allow') {
  if (!['allow', 'ask', 'deny'].includes(bucket)) throw new Error('bad bucket');
  const s = loadSettings(configJsonPath);
  if (!s[bucket].includes(rule)) s[bucket].push(rule);
  return saveSettings(configJsonPath, s);
}

// ── Pending approval queue (for 'ask' decisions) ────────────────────────────
const pending = new Map(); // id -> { action, ctx, decision?, resolver }
const listeners = new Set();

function requestApproval(action, ctx = {}, timeoutMs = 0) {
  const id = `ap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const rec = { id, action, ctx, createdAt: Date.now(), resolver: resolve };
    pending.set(id, rec);
    listeners.forEach(l => { try { l({ type: 'pending', id, action, ctx }); } catch (_) {} });
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ decision: 'deny', reason: 'approval timeout' });
        }
      }, timeoutMs);
    }
  });
}

function resolveApproval(id, decision, promote) {
  const rec = pending.get(id);
  if (!rec) return false;
  pending.delete(id);
  rec.resolver({ decision, promote });
  listeners.forEach(l => { try { l({ type: 'resolved', id, decision, promote }); } catch (_) {} });
  return true;
}

function listPending() {
  return Array.from(pending.values()).map(({ id, action, ctx, createdAt }) => ({ id, action, ctx, createdAt }));
}

function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── Integrated check: evaluate + auto-request if ask ────────────────────────
async function check(action, configJsonPath, ctx = {}) {
  const settings = loadSettings(configJsonPath);
  const result = evaluate(action, settings, ctx);
  if (result.decision === 'allow' || result.decision === 'deny') return result;
  // ask: if caller opted into auto-approval wait, block; else surface as pending
  if (ctx.waitForApproval) {
    const ans = await requestApproval(action, ctx, ctx.timeoutMs || 0);
    if (ans.promote && ans.decision === 'allow') {
      const rule = `${action.type}:${action.value}`;
      try { promoteRule(configJsonPath, rule, 'allow'); } catch (_) {}
    }
    return { ...result, decision: ans.decision, promoted: ans.promote };
  }
  return result; // caller handles ask however it wants
}

// ── Route-level gate ────────────────────────────────────────────────────────
// Returns true if the request should proceed; false if already handled.
// On 'ask' with wait=true, blocks until the user resolves via the modal, up to timeoutMs.
async function gate(res, action, opts = {}) {
  const {
    configPath,
    wait = true,
    timeoutMs = 120000, // 2 minutes
    ctx = {},
    actionLabel,
  } = opts;
  const settings = loadSettings(configPath);
  const result = evaluate(action, settings, ctx);
  if (result.decision === 'allow') return true;
  if (result.decision === 'deny') {
    try { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Permission denied: ${actionLabel || action.value}`, permission: result })); } catch (_) {}
    return false;
  }
  // ask
  if (!wait) {
    try { res.writeHead(412, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Approval required: ${actionLabel || action.value}`, permission: result })); } catch (_) {}
    return false;
  }
  const ans = await requestApproval(action, { ...ctx, label: actionLabel }, timeoutMs);
  if (ans.promote && ans.decision === 'allow') {
    try { promoteRule(configPath, `${action.type}:${action.value}`, 'allow'); } catch (_) {}
  }
  if (ans.decision === 'allow') return true;
  try { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Rejected by user: ${actionLabel || action.value}`, permission: { ...result, decision: ans.decision } })); } catch (_) {}
  return false;
}

module.exports = {
  MODES, DEFAULT_MODE, MODE_DEFAULTS,
  evaluate, matches, compilePattern,
  loadSettings, saveSettings, promoteRule,
  requestApproval, resolveApproval, listPending, onEvent,
  check, gate,
};
