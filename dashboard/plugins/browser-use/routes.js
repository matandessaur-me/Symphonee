// Browser Use plugin -- typed action registry + clickable list +
// watchdog snapshot + Mind-aware step logging on top of /api/browser/*.
//
// All routes namespaced under /api/plugins/browser-use/. The plugin does
// not own any /api/browser/* routes - those still belong to the core
// browser-agent.

'use strict';

const registry = require('./lib/action-registry');

module.exports = function register(ctx) {
  const { json, readBody } = ctx;

  ctx.addRoute('GET', '/health', (req, res) => {
    json(res, { ok: true, plugin: 'browser-use', actions: registry.listActions().length });
  });

  ctx.addRoute('GET', '/actions', (req, res) => {
    json(res, { ok: true, actions: registry.listActions() });
  });

  ctx.addRoute('GET', '/clickables', async (req, res, url) => {
    try {
      const limit = Number(url.searchParams.get('limit') || 200);
      const includeHidden = url.searchParams.get('includeHidden') === 'true' || url.searchParams.get('includeHidden') === '1';
      const result = await registry.runAction('list_clickables', { limit, includeHidden });
      json(res, result);
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
  });

  ctx.addRoute('GET', '/watchdogs', async (req, res) => {
    try {
      const result = await registry.runAction('get_watchdogs', {});
      json(res, result);
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
  });

  ctx.addRoute('POST', '/run-action', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const { action, params } = body || {};
    if (!action) return json(res, { ok: false, error: 'Missing field: action' }, 400);
    try {
      const result = await registry.runAction(action, params || {});
      const savedToMind = await registry.saveStepToMind({
        action,
        params,
        result,
        url: result && result.url ? result.url : null,
      });
      json(res, { ok: true, action, result, savedToMind: !!savedToMind });
    } catch (e) {
      json(res, { ok: false, action, error: e.message }, 500);
    }
  });

  ctx.addRoute('POST', '/run-script', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
    const steps = Array.isArray(body && body.steps) ? body.steps : null;
    if (!steps || !steps.length) return json(res, { ok: false, error: 'Missing or empty: steps[]' }, 400);
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {};
      try {
        const result = await registry.runAction(step.action, step.params || {});
        await registry.saveStepToMind({ action: step.action, params: step.params, result, url: result && result.url ? result.url : null });
        results.push({ ok: true, index: i, action: step.action, result });
      } catch (e) {
        results.push({ ok: false, index: i, action: step.action, error: e.message });
        return json(res, { ok: false, completed: i, total: steps.length, results }, 200);
      }
    }
    json(res, { ok: true, completed: steps.length, total: steps.length, results });
  });
};
