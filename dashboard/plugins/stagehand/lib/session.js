/**
 * Stagehand session manager (local-only).
 *
 * One Stagehand instance per Symphonee process, lazy-initialised on the
 * first call. The `env` is HARD-LOCKED to "LOCAL" -- there is no path that
 * routes through Browserbase cloud, so a misconfigured key cannot trigger
 * paid usage. We accept a model identifier from plugin settings (defaults
 * to anthropic/claude-sonnet-4-6); the user's existing API key for that
 * provider must already be in the environment, same contract Symphonee's
 * model router uses.
 *
 * The Stagehand package is required lazily so installing Symphonee never
 * pulls down the @browserbasehq/stagehand tree by default. If it isn't
 * installed yet we throw a clear "run this npm command" error.
 */

'use strict';

let _stagehand = null;          // resolved Stagehand instance (post-init)
let _initPromise = null;        // in-flight init, so concurrent calls don't double-launch
let _StagehandCtor = null;      // cached class reference

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
async function getSession({ getSettings } = {}) {
  if (_stagehand) return _stagehand;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const Stagehand = _loadStagehand();
    const settings = (typeof getSettings === 'function' ? getSettings() : {}) || {};
    const model = settings.model || 'anthropic/claude-sonnet-4-6';
    const headless = settings.headless === true;

    const sh = new Stagehand({
      env: 'LOCAL',           // hard-locked -- never "BROWSERBASE"
      model,
      verbose: 0,
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
