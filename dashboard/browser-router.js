/**
 * Browser Router - core module, ships with Symphonee.
 *
 * One entry point for browser automation. Callers don't pick between
 * browser-use (typed actions, in-app webview) and Stagehand (natural-language,
 * DOM-resilient) -- this module decides per request, dispatches, and falls back.
 *
 * Mounted from server.js next to mountBrowserRoutes; not a plugin.
 *
 * Routes (under /api/browser/router/*):
 *   GET  /status                -- which drivers are reachable
 *   POST /recommend             -- returns the decision without dispatching
 *   POST /run                   -- decide + dispatch (the main entry point)
 *
 * Dispatch contract for /run:
 *   Body: {
 *     goal?: string,          // free-text task; preferred input
 *     instruction?: string,   // alias for goal
 *     url?: string,           // optional pre-navigation
 *     action?: string,        // typed browser-use action (forces browser-use)
 *     params?: object,        // params for the typed action
 *     selector?: string,      // CSS selector (forces browser-use)
 *     handle?: string|number, // browser-use clickable handle (forces browser-use)
 *     prefer?: 'auto'|'stagehand'|'browser-use',
 *     mode?: 'act'|'extract'|'observe'|'agent',  // hint for Stagehand
 *     maxSteps?: number       // cap for the Stagehand agent loop
 *   }
 *
 * The router falls back automatically: if Stagehand is the chosen driver but
 * the plugin is not loaded or the package is missing, the request is retried
 * against browser-use with a downgrade reason in the response.
 */

'use strict';

const http = require('http');

const ROUTER_PREFIX = '/api/browser/router';

function decide(input, settings) {
  const s = settings || {};
  const prefer = (input && input.prefer) || (s.default && s.default !== 'auto' ? s.default : null);
  if (prefer === 'stagehand' || prefer === 'browser-use') {
    return { driver: prefer, reason: 'explicit prefer=' + prefer, confidence: 1 };
  }

  if (input && (input.action || input.handle != null || input.selector || input.recipeId)) {
    const which = input.action ? 'typed action' : input.handle != null ? 'handle' : input.selector ? 'selector' : 'recipe';
    return { driver: 'browser-use', reason: which + ' supplied -- deterministic path, no LLM needed', confidence: 0.95 };
  }

  const text = (input && (input.goal || input.instruction || '')).toString().trim();
  if (text) {
    const looksRepeat = /^(click|type|fill|press|navigate|goto|wait)\b\s+\S+$/i.test(text);
    if (looksRepeat && s.preferStagehand === false) {
      return { driver: 'browser-use', reason: 'short verb-noun phrase parses as a typed action', confidence: 0.6 };
    }
    return { driver: 'stagehand', reason: 'free-text goal -- DOM-resilient natural-language path', confidence: 0.85 };
  }

  return { driver: s.preferStagehand === false ? 'browser-use' : 'stagehand', reason: 'no signals, fell back to default', confidence: 0.4 };
}

function _readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function _localPost(port, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload || {}));
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Internal-Source': 'browser-router' },
    }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: out ? JSON.parse(out) : {} }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: out, parseError: e.message } }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function _localGet(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: out ? JSON.parse(out) : {} }); }
        catch (_) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.end();
  });
}

async function _stagehandReachable(port) {
  const r = await _localGet(port, '/api/plugins/stagehand/health');
  return r.status === 200 && r.body && r.body.ok === true;
}

async function _dispatchStagehand(port, body) {
  const mode = (body.mode || 'act').toLowerCase();
  const text = body.goal || body.instruction || '';
  // Always seed the page if a URL is given. The agent loop assumes there is
  // already an active StagehandPage to inspect; calling /goto first creates
  // it so the agent's first awaitActivePage doesn't dereference null.
  if (body.url) {
    await _localPost(port, '/api/plugins/stagehand/goto', { url: body.url });
  }
  if (mode === 'extract') return _localPost(port, '/api/plugins/stagehand/extract', { instruction: text });
  if (mode === 'observe') return _localPost(port, '/api/plugins/stagehand/observe', { instruction: text });
  if (mode === 'agent') return _localPost(port, '/api/plugins/stagehand/agent', { task: text, maxSteps: body.maxSteps });
  return _localPost(port, '/api/plugins/stagehand/act', { instruction: text, url: body.url });
}

async function _dispatchBrowserUse(port, body) {
  if (body.action) {
    return _localPost(port, '/api/plugins/browser-use/run-action', { action: body.action, params: body.params || {} });
  }
  if (body.url && !body.goal && !body.instruction && !body.selector && !body.handle) {
    return _localPost(port, '/api/browser/navigate', { url: body.url });
  }
  if (body.handle != null) {
    return _localPost(port, '/api/browser/click-handle', { handle: body.handle });
  }
  if (body.selector) {
    return _localPost(port, '/api/browser/click', { selector: body.selector });
  }
  const text = body.goal || body.instruction || '';
  if (text) {
    return _localPost(port, '/api/browser/click-text', { text });
  }
  return { status: 400, body: { ok: false, error: 'browser-use needs an action, selector, handle, or text' } };
}

function mountBrowserRouterRoutes(addRoute, json, { getConfig, broadcast, port } = {}) {
  const settingsFor = () => {
    try {
      const cfg = (getConfig && getConfig()) || {};
      const r = cfg.BrowserRouter || {};
      return {
        default: r.default || 'auto',
        preferStagehand: r.preferStagehand !== false,
      };
    } catch (_) { return { default: 'auto', preferStagehand: true }; }
  };
  const _port = port || (process.env.SYMPHONEE_PORT && Number(process.env.SYMPHONEE_PORT)) || 3800;

  addRoute('GET', ROUTER_PREFIX + '/status', async (req, res) => {
    const stagehand = await _stagehandReachable(_port);
    const browserUse = (await _localGet(_port, '/api/plugins/browser-use/health')).status === 200;
    json(res, { ok: true, drivers: { stagehand, 'browser-use': true, 'browser-use-plugin': browserUse }, settings: settingsFor() });
  });

  addRoute('POST', ROUTER_PREFIX + '/recommend', async (req, res) => {
    let body; try { body = await _readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const decision = decide(body, settingsFor());
    json(res, { ok: true, ...decision });
  });

  addRoute('POST', ROUTER_PREFIX + '/run', async (req, res) => {
    let body; try { body = await _readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const decision = decide(body, settingsFor());
    const fallbacks = [];
    let driver = decision.driver;

    if (driver === 'stagehand' && !(await _stagehandReachable(_port))) {
      fallbacks.push({ from: 'stagehand', reason: 'plugin not reachable' });
      driver = 'browser-use';
    }

    // Broadcast START so the dashboard switches to Automation -> Browser
    // BEFORE the agent runs, not after. Otherwise the user only sees the
    // navigation event after the work is already done.
    if (typeof broadcast === 'function') {
      try {
        broadcast({ type: 'browser-router-dispatch', phase: 'start', driver, decision, fallbacks, at: Date.now() });
      } catch (_) {}
    }

    try {
      const r = driver === 'stagehand'
        ? await _dispatchStagehand(_port, body)
        : await _dispatchBrowserUse(_port, body);

      if (driver === 'stagehand' && r.status === 501) {
        fallbacks.push({ from: 'stagehand', reason: r.body && r.body.error || 'Stagehand not installed (501)' });
        const r2 = await _dispatchBrowserUse(_port, body);
        if (typeof broadcast === 'function') { try { broadcast({ type: 'browser-router-dispatch', phase: 'end', driver: 'browser-use', decision, fallbacks, at: Date.now() }); } catch (_) {} }
        return json(res, {
          ok: r2.status >= 200 && r2.status < 300 && r2.body && r2.body.ok !== false,
          driver: 'browser-use', decision, fallbacks, result: r2.body,
        }, r2.status || 200);
      }

      if (typeof broadcast === 'function') { try { broadcast({ type: 'browser-router-dispatch', phase: 'end', driver, decision, fallbacks, at: Date.now() }); } catch (_) {} }
      json(res, {
        ok: r.status >= 200 && r.status < 300 && r.body && r.body.ok !== false,
        driver, decision, fallbacks, result: r.body,
      }, r.status || 200);
    } catch (e) {
      if (typeof broadcast === 'function') { try { broadcast({ type: 'browser-router-dispatch', phase: 'error', driver, decision, fallbacks, error: e.message, at: Date.now() }); } catch (_) {} }
      json(res, { ok: false, driver, decision, fallbacks, error: e.message }, 500);
    }
  });
}

module.exports = { mountBrowserRouterRoutes, decide };
