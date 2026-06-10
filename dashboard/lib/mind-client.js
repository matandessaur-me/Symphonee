/**
 * MindClient - the config-object contract that turns Mind into a SERVICE the
 * brain and agents consume, instead of an in-process module they reach into.
 *
 * Stage 1 of the Symphonee 2.0 plan (notes: symphonee-2.0-development-plan,
 * mind-extraction-scope, Phase 1): "Brain becomes a CLIENT of Mind, not a
 * co-owner of the graph." Before this, brain/answer did `store.loadGraph()` +
 * `recall(graph, ...)` in-process, and agents required `mind/store` +
 * `mind/query` directly. That is the coupling this client severs: callers now
 * depend ONLY on `createMindClient(config).recall()/query()`. The single place
 * that still touches the graph store lives HERE, at the contract boundary.
 *
 * Two transports behind one identical contract:
 *
 *   'inproc' (default) - calls mind/store + mind/recall + mind/query in the
 *       same process. This is correct for the in-app (Electron) deployment:
 *       there is no point making an authenticated HTTP round-trip to yourself,
 *       and it keeps behaviour byte-for-byte identical to the pre-Stage-1 code
 *       (the Phase-1 regression risk the plan warns about reduces to zero).
 *
 *   'http' - POSTs /api/mind/recall + /api/mind/query over the frozen route
 *       contract. This is the path for the EXTRACTED deployment (Phase 2/3:
 *       @symphonee/mind as a standalone or remote server) where in-process is
 *       not an option. Note: those POST routes sit behind the server's per-boot
 *       auth-token gate, so an http client to the live host must supply
 *       `authHeaders`. Proven end-to-end against the real route handlers in
 *       mind-client.test.js.
 *
 * The contract is the win; the transport is a deployment detail. Flip the
 * in-app default to 'http' only once the live server's auth wiring + a restart
 * smoke-test confirm the self-call path.
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_BASE = process.env.SYMPHONEE_MIND_URL || 'http://127.0.0.1:3800';

function _post(baseUrl, route, body, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(route, baseUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body || {}));
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : {}; } catch (e) { return resolve({ status: res.statusCode, json: null, parseError: e.message }); }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('mind-client: request timed out after ' + timeoutMs + 'ms')); });
    req.end(payload);
  });
}

/**
 * @param config {
 *   transport?:   'inproc' | 'http'         (default 'inproc')
 *   repoRoot?:    string                     (inproc: where the graph lives)
 *   space?:       string                     (default space when not per-call)
 *   getSpace?:    () => string               (dynamic space resolver)
 *   baseUrl?:     string                     (http: server base, default :3800)
 *   authHeaders?: () => object               (http: per-boot token headers)
 *   timeoutMs?:   number
 * }
 */
function createMindClient(config = {}) {
  const transport = config.transport || 'inproc';
  const baseUrl = config.baseUrl || DEFAULT_BASE;
  const repoRoot = config.repoRoot || process.cwd();
  const timeoutMs = config.timeoutMs || 15000;
  const getSpace = typeof config.getSpace === 'function'
    ? config.getSpace
    : () => (config.space || '_global');
  const authHeaders = typeof config.authHeaders === 'function' ? config.authHeaders : () => ({});

  // In-process backend. The mind/* requires are intentionally lazy and scoped
  // to this closure so they are the ONLY graph coupling in the whole client -
  // brain/ and agents/ never see them.
  function _inproc() {
    const store = require('../mind/store');
    return {
      recall(opts) {
        const space = opts.space || getSpace();
        const g = store.loadGraph(repoRoot, space);
        if (!g) return { hits: [], total: 0, message: 'no graph for this space' };
        return require('../mind/recall').recall(g, {
          question: opts.question || '', since: opts.since, until: opts.until,
          repo: opts.repo, kinds: opts.kinds, limit: opts.limit,
        });
      },
      query(opts) {
        const space = opts.space || getSpace();
        const g = store.loadGraph(repoRoot, space);
        if (!g || !g.nodes || !g.nodes.length) return { question: opts.question || '', empty: true, nodes: [], edges: [], answer: null };
        return require('../mind/query').runQuery(g, {
          question: opts.question || '', budget: opts.budget, seedIds: opts.seedIds,
          asOf: opts.asOf, mode: opts.mode,
        });
      },
    };
  }

  async function recall(opts = {}) {
    if (transport === 'inproc') return _inproc().recall(opts);
    const r = await _post(baseUrl, '/api/mind/recall', {
      question: opts.question || '', since: opts.since, until: opts.until,
      repo: opts.repo, kinds: opts.kinds, limit: opts.limit,
    }, { timeoutMs, headers: authHeaders() });
    return (r && r.json) || { hits: [], total: 0 };
  }

  async function query(opts = {}) {
    if (transport === 'inproc') return _inproc().query(opts);
    const r = await _post(baseUrl, '/api/mind/query', {
      question: opts.question || '', budget: opts.budget, seedIds: opts.seedIds,
      asOf: opts.asOf, mode: opts.mode,
    }, { timeoutMs, headers: authHeaders() });
    return (r && r.json) || { nodes: [], edges: [], empty: true };
  }

  return { recall, query, transport, baseUrl };
}

module.exports = { createMindClient, DEFAULT_BASE };
