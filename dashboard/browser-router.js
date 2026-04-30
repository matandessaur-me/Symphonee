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

// Driver options:
//   "browser-use"   -- typed actions on the in-app webview, no LLM round-trips.
//   "in-app-agent"  -- LLM tool-use loop driving the in-app webview directly,
//                      so the user can watch live AND interact mid-run.
//   "stagehand"     -- LLM agent loop driving a separate headless Chromium
//                      (sandboxed, fresh profile, schema-validated extract).
function decide(input, settings) {
  const s = settings || {};
  const prefer = (input && input.prefer) || (s.default && s.default !== 'auto' ? s.default : null);
  const preferStagehand = s.preferStagehand !== false;
  if (prefer === 'stagehand' || prefer === 'browser-use' || prefer === 'in-app-agent') {
    return { driver: prefer, reason: 'explicit prefer=' + prefer, confidence: 1 };
  }

  if (input && (input.action || input.handle != null || input.selector)) {
    const which = input.action ? 'typed action' : input.handle != null ? 'handle' : 'selector';
    return { driver: 'browser-use', reason: which + ' supplied -- deterministic path, no LLM needed', confidence: 0.95 };
  }

  const text = (input && (input.goal || input.instruction || '')).toString().trim();
  // Sandboxed/schema requests benefit from Stagehand's clean profile + Zod
  // extract. Otherwise default to the in-app agent so the user watches the
  // run in their normal browser and can take over at any point.
  const wantsSandbox = !!(input && (input.sandboxed || input.fresh || input.headless));
  const wantsSchema = !!(input && input.schema);
  const wantsExtractMode = (input && String(input.mode || '').toLowerCase()) === 'extract';

  if (text) {
    if (wantsSandbox || wantsSchema || wantsExtractMode) {
      return { driver: 'stagehand', reason: 'sandboxed/structured-extract task -- Stagehand SDK preferred', confidence: 0.9 };
    }
    const looksRepeat = /^(click|type|fill|press|navigate|goto|wait)\b\s+\S+$/i.test(text);
    if (looksRepeat) {
      if (preferStagehand) {
        return { driver: 'stagehand', reason: 'preferStagehand enabled for ambiguous short verb-noun goal', confidence: 0.8 };
      }
      return { driver: 'browser-use', reason: 'short verb-noun phrase parses as a typed action', confidence: 0.7 };
    }
    return { driver: 'in-app-agent', reason: 'free-text goal -- LLM tool-use loop on the live in-app webview', confidence: 0.85 };
  }

  return { driver: 'in-app-agent', reason: 'no signals, fell back to in-app default', confidence: 0.4 };
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

async function _stagehandHealth(port) {
  const r = await _localGet(port, '/api/plugins/stagehand/health');
  return r.status === 200 && r.body && typeof r.body === 'object' ? r.body : null;
}

async function _stagehandReachable(port) {
  const health = await _stagehandHealth(port);
  return !!(health && health.ok === true && health.ready === true);
}

async function _inAppAgentReachable(port) {
  const r = await _localGet(port, '/api/browser/agent/status');
  return r.status === 200 && r.body && r.body.ok === true;
}

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _dispatchInAppAgent(port, body, settings) {
  // Generate a router-owned threadId so we don't collide with the user's
  // in-tab "Ask AI" thread (which always uses 'default').
  const threadId = 'router-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const task = body.goal || body.instruction || '';
  // Apply user's saved In-App Agent default (Settings -> Browser) when the
  // request doesn't specify a model. Provider is inferred from the model
  // prefix (anthropic/, openai/, google/, xai/).
  let modelOverride = body.model;
  let providerOverride = body.provider;
  if (!modelOverride && settings && settings.inAppAgentModel) {
    const m = String(settings.inAppAgentModel);
    modelOverride = m.includes('/') ? m.split('/').slice(1).join('/') : m;
    if (!providerOverride && m.includes('/')) {
      const p = m.split('/')[0];
      providerOverride = p === 'google' ? 'gemini' : (p === 'anthropic' ? 'anthropic' : (p === 'openai' ? 'openai' : (p === 'xai' ? 'xai' : undefined)));
    }
  }
  const start = await _localPost(port, '/api/browser/agent/chat', {
    task, threadId,
    provider: providerOverride || undefined,
    model: modelOverride || undefined,
  });
  if (start.status >= 400) return start;

  // Pre-navigate if a URL was supplied; the agent will pick it up from there.
  if (body.url) {
    await _localPost(port, '/api/browser/navigate', { url: body.url });
  }

  // Poll status until the run finishes. Status returns lastResult once
  // runThread reaches its emit({kind:'done'|'error'|'stopped'}) sites.
  const deadline = Date.now() + (Number.isFinite(body.timeoutMs) ? body.timeoutMs : 600_000);
  while (Date.now() < deadline) {
    const st = await _localGet(port, '/api/browser/agent/status?threadId=' + encodeURIComponent(threadId));
    if (st.status === 200 && st.body && st.body.lastResult) {
      return { status: 200, body: { ok: !!st.body.lastResult.ok, ...st.body.lastResult, threadId } };
    }
    if (st.status === 200 && st.body && !st.body.running) {
      // Race: thread finished before lastResult landed; brief retry.
      await _wait(150);
      const st2 = await _localGet(port, '/api/browser/agent/status?threadId=' + encodeURIComponent(threadId));
      if (st2.body && st2.body.lastResult) {
        return { status: 200, body: { ok: !!st2.body.lastResult.ok, ...st2.body.lastResult, threadId } };
      }
      return { status: 200, body: { ok: false, error: 'In-app agent finished but no result captured', threadId } };
    }
    await _wait(500);
  }
  return { status: 504, body: { ok: false, error: 'In-app agent timed out', threadId } };
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
  if (mode === 'extract') return _localPost(port, '/api/plugins/stagehand/extract', { instruction: text, schema: body.schema });
  if (mode === 'observe') return _localPost(port, '/api/plugins/stagehand/observe', { instruction: text });
  if (mode === 'agent') return _localPost(port, '/api/plugins/stagehand/agent', { task: text, maxSteps: body.maxSteps });
  return _localPost(port, '/api/plugins/stagehand/act', { instruction: text, url: body.url });
}

async function _dispatchBrowserUse(port, body) {
  if (body.recipeId) {
    return { status: 400, body: { ok: false, error: 'recipeId is not supported by the Browser Router yet' } };
  }
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

function _shouldFallbackFromStagehand(r) {
  if (!r || typeof r.status !== 'number') return false;
  const code = r.body && r.body.code;
  return r.status === 501
    || (r.status === 400 && (code === 'STAGEHAND_NO_API_KEY' || code === 'STAGEHAND_NOT_INSTALLED'));
}

function _stagehandFallbackReason(r, fallback) {
  if (fallback) return fallback;
  if (r && r.body && r.body.error) return r.body.error;
  return 'Stagehand unavailable';
}

function _stringifyResultForSignals(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function _shouldFallbackFromInAppAgent(r) {
  if (!r || typeof r.status !== 'number') return false;
  if (r.status === 408 || r.status === 504) return true;
  const body = r.body || {};
  if (body.ok !== false) return false;
  const text = _stringifyResultForSignals(body).toLowerCase();

  // Retry when the in-app webview can load the site shell but the agent
  // reports that the real work surface is hidden, virtualized, canvas-backed,
  // or otherwise not interactable through its normal browser tools.
  return /(?:can't|cannot|unable to|not able to|could not|couldn't)\s+(?:see|view|read|inspect|access|interact|click|edit|find|locate|detect)/.test(text)
    || /(?:not visible|not accessible|inaccessible|not interactable|can't interact|cannot interact|unable to interact)/.test(text)
    || /(?:canvas|iframe|embedded|virtualized|shadow dom|webview|spreadsheet|worksheet|cell|grid).{0,120}(?:can't|cannot|unable|not visible|not accessible|not interactable|inaccessible)/.test(text)
    || /(?:can't|cannot|unable|not able).{0,120}(?:canvas|iframe|embedded|virtualized|spreadsheet|worksheet|cell|grid)/.test(text);
}

function _stagehandBodyForInAppFallback(body) {
  const next = { ...(body || {}) };
  if (!next.mode && !next.schema) next.mode = 'agent';
  if (next.mode === 'agent' && !Number.isFinite(next.maxSteps)) next.maxSteps = 12;
  return next;
}

function mountBrowserRouterRoutes(addRoute, json, { getConfig, broadcast, port } = {}) {
  const settingsFor = () => {
    try {
      const cfg = (getConfig && getConfig()) || {};
      const r = cfg.BrowserRouter || {};
      const a = cfg.InAppAgent || {};
      return {
        default: r.default || 'auto',
        preferStagehand: r.preferStagehand !== false,
        inAppAgentModel: a.model || null,
      };
    } catch (_) { return { default: 'auto', preferStagehand: true, inAppAgentModel: null }; }
  };
  const _port = port || (process.env.SYMPHONEE_PORT && Number(process.env.SYMPHONEE_PORT)) || 3800;

  addRoute('GET', ROUTER_PREFIX + '/status', async (req, res) => {
    const stagehandHealth = await _stagehandHealth(_port);
    const stagehand = !!(stagehandHealth && stagehandHealth.ok === true && stagehandHealth.ready === true);
    const browserUse = (await _localGet(_port, '/api/plugins/browser-use/health')).status === 200;
    const inAppAgent = await _inAppAgentReachable(_port);
    json(res, {
      ok: true,
      drivers: {
        'in-app-agent': inAppAgent,
        stagehand,
        'browser-use': true,
        'browser-use-plugin': browserUse,
      },
      details: {
        stagehand: stagehandHealth,
      },
      settings: settingsFor(),
    });
  });

  addRoute('POST', ROUTER_PREFIX + '/recommend', async (req, res) => {
    let body; try { body = await _readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const decision = decide(body, settingsFor());
    json(res, { ok: true, ...decision });
  });

  addRoute('POST', ROUTER_PREFIX + '/run', async (req, res) => {
    let body; try { body = await _readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    if (body && body.recipeId) {
      return json(res, { ok: false, error: 'recipeId is not supported by the Browser Router yet' }, 400);
    }
    const decision = decide(body, settingsFor());
    const fallbacks = [];
    let driver = decision.driver;

    if (driver === 'in-app-agent' && !(await _inAppAgentReachable(_port))) {
      fallbacks.push({ from: 'in-app-agent', reason: 'agent chat route not reachable' });
      driver = (await _stagehandReachable(_port)) ? 'stagehand' : 'browser-use';
    }
    if (driver === 'stagehand' && !(await _stagehandReachable(_port))) {
      const health = await _stagehandHealth(_port);
      fallbacks.push({ from: 'stagehand', reason: _stagehandFallbackReason(null, health && health.error ? health.error : 'plugin not ready') });
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
      const settings = settingsFor();
      const r = driver === 'in-app-agent'
        ? await _dispatchInAppAgent(_port, body, settings)
        : driver === 'stagehand'
          ? await _dispatchStagehand(_port, body)
          : await _dispatchBrowserUse(_port, body);

      if (driver === 'in-app-agent' && _shouldFallbackFromInAppAgent(r) && await _stagehandReachable(_port)) {
        fallbacks.push({
          from: 'in-app-agent',
          to: 'stagehand',
          reason: 'in-app agent reported an inaccessible or non-interactable page surface',
        });
        if (typeof broadcast === 'function') {
          try { broadcast({ type: 'browser-router-dispatch', phase: 'start', driver: 'stagehand', decision, fallbacks, at: Date.now() }); } catch (_) {}
        }
        const stagehandBody = _stagehandBodyForInAppFallback(body);
        const r2 = await _dispatchStagehand(_port, stagehandBody);
        if (!_shouldFallbackFromStagehand(r2)) {
          if (typeof broadcast === 'function') { try { broadcast({ type: 'browser-router-dispatch', phase: 'end', driver: 'stagehand', decision, fallbacks, at: Date.now() }); } catch (_) {} }
          return json(res, {
            ok: r2.status >= 200 && r2.status < 300 && r2.body && r2.body.ok !== false,
            driver: 'stagehand', decision, fallbacks, result: r2.body,
            initialResult: r.body,
          }, r2.status || 200);
        }
        fallbacks.push({ from: 'stagehand', reason: _stagehandFallbackReason(r2) });
        const r3 = await _dispatchBrowserUse(_port, body);
        if (typeof broadcast === 'function') { try { broadcast({ type: 'browser-router-dispatch', phase: 'end', driver: 'browser-use', decision, fallbacks, at: Date.now() }); } catch (_) {} }
        return json(res, {
          ok: r3.status >= 200 && r3.status < 300 && r3.body && r3.body.ok !== false,
          driver: 'browser-use', decision, fallbacks, result: r3.body,
          initialResult: r.body,
        }, r3.status || 200);
      }

      if (driver === 'stagehand' && _shouldFallbackFromStagehand(r)) {
        fallbacks.push({ from: 'stagehand', reason: _stagehandFallbackReason(r) });
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
