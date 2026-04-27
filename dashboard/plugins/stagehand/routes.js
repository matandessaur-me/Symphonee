/**
 * Stagehand plugin routes -- all under /api/plugins/stagehand/*.
 *
 * Exposes the four Stagehand primitives over REST so any CLI worker can call
 * them by HTTP without taking a hard dependency on the Stagehand package:
 *
 *   POST /act      { instruction, url? }
 *   POST /extract  { instruction, schema? }     -- schema is JSON-Schema-ish
 *   POST /observe  { instruction }
 *   POST /agent    { task, maxSteps? }          -- multi-step loop
 *   POST /goto     { url }                      -- helper for chaining
 *   POST /close                                 -- tear down the session
 *   GET  /health                                -- readiness + env confirmation
 *
 * Local-only: the session manager hard-locks env="LOCAL", so no request from
 * here can route through Browserbase cloud.
 */

'use strict';

const session = require('./lib/session');
const mindLog = require('./lib/mind-log');
const screencast = require('./lib/screencast');

function _err(json, res, e, status) {
  let code = status || 500;
  if (e && e.code === 'STAGEHAND_NOT_INSTALLED') code = 501;
  else if (e && e.code === 'STAGEHAND_NO_API_KEY') code = 400;
  json(res, { ok: false, error: e && e.message || String(e), code: e && e.code }, code);
}

async function _currentUrl(sh) {
  try {
    const pages = sh.context.pages();
    const page = pages[0];
    return page ? page.url() : null;
  } catch (_) { return null; }
}

module.exports = function register(ctx) {
  const { json, readBody, getConfig, broadcast } = ctx;
  const getSettings = () => {
    try { return (getConfig && getConfig('stagehand.settings')) || {}; }
    catch (_) { return {}; }
  };

  // Auto-start the screencast on the first successful primitive so the Browser
  // tab shows what Stagehand is doing without a separate API call.
  let _autoCastTried = false;
  async function _ensureAutoCast() {
    if (_autoCastTried) return;
    _autoCastTried = true;
    try {
      const sh = await session.getSession({ getSettings, getConfig });
      await screencast.startScreencast(sh, { broadcast });
    } catch (_) { _autoCastTried = false; }
  }

  ctx.addRoute('GET', '/health', async (req, res) => {
    json(res, {
      ok: true,
      plugin: 'stagehand',
      env: 'LOCAL',
      ready: session.isReady(),
      streaming: screencast.isStreaming(),
      cloudReachable: false,
    });
  });

  ctx.addRoute('POST', '/screencast/start', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    try {
      const sh = await session.getSession({ getSettings, getConfig });
      const r = await screencast.startScreencast(sh, {
        broadcast,
        format: body.format || 'jpeg',
        quality: Number.isFinite(body.quality) ? body.quality : 60,
        everyNthFrame: Number.isFinite(body.everyNthFrame) ? body.everyNthFrame : 1,
        maxWidth: Number.isFinite(body.maxWidth) ? body.maxWidth : 1280,
      });
      json(res, r);
    } catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/screencast/stop', async (req, res) => {
    try { json(res, await screencast.stopScreencast()); }
    catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/goto', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const url = body && body.url;
    if (!url || typeof url !== 'string') return json(res, { ok: false, error: 'Missing field: url' }, 400);
    try {
      const sh = await session.getSession({ getSettings, getConfig });
      // Prefer the StagehandPage wrapper -- it's what the agent loop's
      // awaitActivePage tracks. Falling back to the raw context page leaves
      // stagehand.activePage null and breaks the agent on first step.
      const page = sh.page || sh.context.pages()[0] || await sh.context.newPage();
      await page.goto(url);
      // Now that the page exists, start the screencast eagerly so frames flow
      // before the agent loop adds further work.
      _ensureAutoCast();
      json(res, { ok: true, url: page.url() });
    } catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/act', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const instruction = body && body.instruction;
    if (!instruction) return json(res, { ok: false, error: 'Missing field: instruction' }, 400);
    try {
      const sh = await session.getSession({ getSettings, getConfig });
      if (body.url) {
        const page = sh.page || sh.context.pages()[0] || await sh.context.newPage();
        await page.goto(body.url);
      }
      _ensureAutoCast();
      const result = await sh.act(instruction);
      const url = await _currentUrl(sh);
      mindLog.saveStep({ primitive: 'act', prompt: instruction, url, result });
      json(res, { ok: true, primitive: 'act', url, result });
    } catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/extract', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const instruction = body && body.instruction;
    if (!instruction) return json(res, { ok: false, error: 'Missing field: instruction' }, 400);
    try {
      const sh = await session.getSession({ getSettings, getConfig });
      const opts = {};
      if (body.schema && typeof body.schema === 'object') {
        // We don't take a Zod object over the wire -- pass the raw prompt and
        // let Stagehand return a free-form extraction. Callers that need
        // typed data can validate downstream.
      }
      _ensureAutoCast();
      const result = await sh.extract(instruction, opts);
      const url = await _currentUrl(sh);
      mindLog.saveStep({ primitive: 'extract', prompt: instruction, url, result });
      json(res, { ok: true, primitive: 'extract', url, result });
    } catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/observe', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const instruction = body && body.instruction;
    if (!instruction) return json(res, { ok: false, error: 'Missing field: instruction' }, 400);
    try {
      const sh = await session.getSession({ getSettings, getConfig });
      _ensureAutoCast();
      const result = await sh.observe(instruction);
      const url = await _currentUrl(sh);
      mindLog.saveStep({ primitive: 'observe', prompt: instruction, url, result });
      json(res, { ok: true, primitive: 'observe', url, result });
    } catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/agent', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const task = body && body.task;
    if (!task) return json(res, { ok: false, error: 'Missing field: task' }, 400);
    const maxSteps = Number.isFinite(body.maxSteps) ? Math.min(50, Math.max(1, body.maxSteps)) : 10;
    try {
      const sh = await session.getSession({ getSettings, getConfig });
      const agent = sh.agent ? sh.agent() : null;
      if (!agent || typeof agent.execute !== 'function') {
        return json(res, { ok: false, error: 'Agent loop not available in this Stagehand build' }, 501);
      }
      _ensureAutoCast();
      const result = await agent.execute({ instruction: task, maxSteps });
      const url = await _currentUrl(sh);
      mindLog.saveStep({ primitive: 'agent', prompt: task, url, result });
      json(res, { ok: true, primitive: 'agent', url, result });
    } catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/close', async (req, res) => {
    try {
      try { await screencast.stopScreencast(); } catch (_) {}
      _autoCastTried = false;
      await session.closeSession();
      json(res, { ok: true, closed: true });
    } catch (e) { _err(json, res, e); }
  });
};
