/**
 * Stagehand session manager (local-only).
 *
 * One Stagehand instance per Symphonee process, lazy-initialised on the
 * first call. The `env` is HARD-LOCKED to "LOCAL" -- there is no path that
 * routes through Browserbase cloud, so a misconfigured key cannot trigger
 * paid usage. The model identifier (anthropic/claude-..., openai/gpt-...,
 * google/gemini-...) is read from plugin settings; the matching API key is
 * pulled from Symphonee's saved AiApiKeys (config.AiApiKeys.<NAME>) with a
 * fallback to process.env so existing env-based setups keep working.
 *
 * The Stagehand package is required lazily so installing Symphonee never
 * pulls down the @browserbasehq/stagehand tree by default. If it isn't
 * installed yet we throw a clear "run this npm command" error.
 */

'use strict';

let _stagehand = null;          // resolved Stagehand instance (post-init)
let _initPromise = null;        // in-flight init, so concurrent calls don't double-launch
let _StagehandCtor = null;      // cached class reference

// Map a model identifier to (a) the Symphonee AiApiKeys field name and
// (b) the Stagehand modelClientOptions key. Stagehand routes the model based
// on the provider prefix in the model string ("anthropic/...", "openai/...",
// "google/..."), and accepts an apiKey via modelClientOptions.
function _providerForModel(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('anthropic/') || m.startsWith('claude')) return { configKey: 'ANTHROPIC_API_KEY', envKey: 'ANTHROPIC_API_KEY' };
  if (m.startsWith('openai/') || m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return { configKey: 'OPENAI_API_KEY', envKey: 'OPENAI_API_KEY' };
  if (m.startsWith('google/') || m.startsWith('gemini')) return { configKey: 'GEMINI_API_KEY', envKey: 'GEMINI_API_KEY' };
  if (m.startsWith('xai/') || m.startsWith('grok')) return { configKey: 'XAI_API_KEY', envKey: 'XAI_API_KEY' };
  return { configKey: 'ANTHROPIC_API_KEY', envKey: 'ANTHROPIC_API_KEY' };
}

function _resolveApiKey(model, getConfig) {
  const { configKey, envKey } = _providerForModel(model);
  let cfg = {};
  try { cfg = (typeof getConfig === 'function' ? getConfig() : {}) || {}; } catch (_) {}
  const saved = (cfg.AiApiKeys && cfg.AiApiKeys[configKey]) || null;
  return saved || process.env[envKey] || null;
}

// The Stagehand SDK uses two code paths: act/extract/observe accept the key
// via modelClientOptions, but the agent() loop creates its own provider client
// that reads from process.env only. Mirror every saved AiApiKey into env so
// both paths see them. Idempotent.
function _exportSavedKeysToEnv(getConfig) {
  let cfg = {};
  try { cfg = (typeof getConfig === 'function' ? getConfig() : {}) || {}; } catch (_) { return; }
  const saved = cfg.AiApiKeys || {};
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DASHSCOPE_API_KEY']) {
    if (saved[k] && !process.env[k]) process.env[k] = saved[k];
  }
}

function _loadStagehand() {
  if (_StagehandCtor) return _StagehandCtor;
  try {
    const mod = require('@browserbasehq/stagehand');
    _StagehandCtor = mod.Stagehand || mod.default || mod;
    if (!_StagehandCtor) throw new Error('Stagehand export shape unexpected');
    return _StagehandCtor;
  } catch (e) {
    const hint = 'Stagehand is not installed. From the Symphonee directory run: npm install @browserbasehq/stagehand chrome-launcher';
    const err = new Error(hint + ' (underlying: ' + e.message + ')');
    err.code = 'STAGEHAND_NOT_INSTALLED';
    throw err;
  }
}

/**
 * Returns the singleton Stagehand instance, initialising it on first call.
 * `getSettings` is the plugin context's getConfig-like helper.
 */
async function getSession({ getSettings, getConfig } = {}) {
  if (_stagehand) return _stagehand;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const Stagehand = _loadStagehand();
    const settings = (typeof getSettings === 'function' ? getSettings() : {}) || {};
    const model = settings.model || 'anthropic/claude-sonnet-4-6';
    const headless = settings.headless === true;

    _exportSavedKeysToEnv(getConfig);
    const apiKey = _resolveApiKey(model, getConfig);
    const provider = _providerForModel(model);
    if (!apiKey) {
      const err = new Error(
        'No API key for model "' + model + '". Add ' + provider.configKey +
        ' in Settings -> AI Keys, or set the ' + provider.envKey + ' environment variable.'
      );
      err.code = 'STAGEHAND_NO_API_KEY';
      throw err;
    }

    const sh = new Stagehand({
      env: 'LOCAL',           // hard-locked -- never "BROWSERBASE"
      model,
      modelClientOptions: { apiKey },
      verbose: 0,
      // keepAlive prevents Stagehand's shutdown supervisor from killing the
      // launched Chrome between separate HTTP requests. Without it, /goto
      // succeeds but the agent's first tool call hits a closed CDP socket
      // (code=1006) and ariaTree dereferences a null v3.context. We tear the
      // browser down explicitly in closeSession() instead.
      keepAlive: true,
      localBrowserLaunchOptions: { headless },
    });
    await sh.init();
    _stagehand = sh;
    return sh;
  })().catch((e) => {
    _initPromise = null;
    throw e;
  });

  return _initPromise;
}

async function closeSession() {
  if (_stagehand) {
    try { await _stagehand.close(); } catch (_) { /* best-effort */ }
    _stagehand = null;
  }
  _initPromise = null;
}

function isReady() { return !!_stagehand; }

module.exports = { getSession, closeSession, isReady };
