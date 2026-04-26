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

function _err(json, res, e, status) {
  const code = e && e.code === 'STAGEHAND_NOT_INSTALLED' ? 501 : (status || 500);
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
  const { json, readBody, getConfig } = ctx;
  const getSettings = () => {
    try { return (getConfig && getConfig('stagehand.settings')) || {}; }
    catch (_) { return {}; }
  };

  ctx.addRoute('GET', '/health', async (req, res) => {
    json(res, {
      ok: true,
      plugin: 'stagehand',
      env: 'LOCAL',
      ready: session.isReady(),
      cloudReachable: false,
    });
  });

  ctx.addRoute('POST', '/goto', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const url = body && body.url;
    if (!url || typeof url !== 'string') return json(res, { ok: false, error: 'Missing field: url' }, 400);
    try {
      const sh = await session.getSession({ getSettings });
      const page = sh.context.pages()[0] || await sh.context.newPage();
      await page.goto(url);
      json(res, { ok: true, url: page.url() });
    } catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/act', async (req, res) => {
    let body; try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const instruction = body && body.instruction;
    if (!instruction) return json(res, { ok: false, error: 'Missing field: instruction' }, 400);
    try {
      const sh = await session.getSession({ getSettings });
      if (body.url) {
        const page = sh.context.pages()[0] || await sh.context.newPage();
        await page.goto(body.url);
      }
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
      const sh = await session.getSession({ getSettings });
      const opts = {};
      if (body.schema && typeof body.schema === 'object') {
        // We don't take a Zod object over the wire -- pass the raw prompt and
        // let Stagehand return a free-form extraction. Callers that need
        // typed data can validate downstream.
      }
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
      const sh = await session.getSession({ getSettings });
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
      const sh = await session.getSession({ getSettings });
      const agent = sh.agent ? sh.agent() : null;
      if (!agent || typeof agent.execute !== 'function') {
        return json(res, { ok: false, error: 'Agent loop not available in this Stagehand build' }, 501);
      }
      const result = await agent.execute({ instruction: task, maxSteps });
      const url = await _currentUrl(sh);
      mindLog.saveStep({ primitive: 'agent', prompt: task, url, result });
      json(res, { ok: true, primitive: 'agent', url, result });
    } catch (e) { _err(json, res, e); }
  });

  ctx.addRoute('POST', '/close', async (req, res) => {
    try {
      await session.closeSession();
      json(res, { ok: true, closed: true });
    } catch (e) { _err(json, res, e); }
  });
};
