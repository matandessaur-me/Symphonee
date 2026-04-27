'use strict';

const assert = require('node:assert/strict');
const http = require('http');
const test = require('node:test');

const { mountBrowserRouterRoutes } = require('./browser-router');

function createJsonHelpers() {
  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
  return { json, readBody };
}

async function withRouterServer(options, fn) {
  const routes = new Map();
  const calls = [];
  const { json, readBody } = createJsonHelpers();
  const addRoute = (method, path, handler) => {
    routes.set(method + ' ' + path, handler);
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = req.method + ' ' + url.pathname;
    const handler = routes.get(key);
    if (!handler) return json(res, { error: 'not found', path: url.pathname }, 404);
    try {
      await handler(req, res, url);
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  addRoute('GET', '/api/plugins/stagehand/health', async (req, res) => {
    json(res, options.stagehandHealth || { ok: true, ready: true });
  });
  addRoute('POST', '/api/plugins/stagehand/extract', async (req, res) => {
    const body = await readBody(req);
    calls.push({ path: '/api/plugins/stagehand/extract', body });
    json(res, { ok: true, echoed: body });
  });
  addRoute('POST', '/api/plugins/stagehand/goto', async (req, res) => {
    const body = await readBody(req);
    calls.push({ path: '/api/plugins/stagehand/goto', body });
    json(res, { ok: true, url: body.url || null });
  });
  addRoute('GET', '/api/plugins/browser-use/health', async (req, res) => {
    json(res, { ok: true, plugin: 'browser-use' });
  });
  addRoute('GET', '/api/browser/agent/status', async (req, res) => {
    json(res, options.inAppStatus || { ok: true, running: false });
  });
  addRoute('POST', '/api/browser/click-text', async (req, res) => {
    const body = await readBody(req);
    calls.push({ path: '/api/browser/click-text', body });
    json(res, { ok: true, clicked: body.text || null });
  });

  mountBrowserRouterRoutes(addRoute, json, {
    getConfig: () => ({
      BrowserRouter: {
        default: 'auto',
        preferStagehand: options.preferStagehand !== false,
      },
    }),
    broadcast: () => {},
    port,
  });

  const request = (method, path, body) => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  try {
    await fn({ request, calls });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('preferStagehand changes ambiguous short-goal routing', async () => {
  await withRouterServer({ preferStagehand: true }, async ({ request }) => {
    const res = await request('POST', '/api/browser/router/recommend', { goal: 'click login' });
    assert.equal(res.status, 200);
    assert.equal(res.body.driver, 'stagehand');
  });
  await withRouterServer({ preferStagehand: false }, async ({ request }) => {
    const res = await request('POST', '/api/browser/router/recommend', { goal: 'click login' });
    assert.equal(res.status, 200);
    assert.equal(res.body.driver, 'browser-use');
  });
});

test('router status uses stagehand ready flag, not route reachability alone', async () => {
  await withRouterServer({ stagehandHealth: { ok: true, ready: false, code: 'STAGEHAND_NO_API_KEY' } }, async ({ request }) => {
    const res = await request('GET', '/api/browser/router/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.drivers.stagehand, false);
    assert.equal(res.body.details.stagehand.code, 'STAGEHAND_NO_API_KEY');
  });
});

test('router rejects unsupported recipeId explicitly', async () => {
  await withRouterServer({}, async ({ request }) => {
    const res = await request('POST', '/api/browser/router/run', { recipeId: 'demo-recipe' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /recipeId is not supported/i);
  });
});

test('schema requests are forwarded to stagehand extract', async () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } } };
  await withRouterServer({ stagehandHealth: { ok: true, ready: true } }, async ({ request, calls }) => {
    const res = await request('POST', '/api/browser/router/run', {
      goal: 'extract the title',
      mode: 'extract',
      schema,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.driver, 'stagehand');
    const extractCall = calls.find((entry) => entry.path === '/api/plugins/stagehand/extract');
    assert.deepEqual(extractCall.body.schema, schema);
  });
});
