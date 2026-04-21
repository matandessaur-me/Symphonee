/**
 * Symphonee -- Model Context Protocol (MCP) server, stdio transport.
 *
 * Implements the minimum viable MCP spec:
 *   - JSON-RPC 2.0 framing (newline-delimited, stdin/stdout)
 *   - initialize / notifications/initialized lifecycle
 *   - tools/list, tools/call
 *   - resources/list, resources/read
 *   - prompts/list, prompts/get
 *
 * The server is a thin adapter: every tool call forwards to the running
 * Symphonee HTTP server at 127.0.0.1:3800, which already enforces
 * permissions, caching, and business logic. If Symphonee is not
 * running, tool calls return an error (no silent no-ops).
 *
 * Designed to be launched by an MCP client (Claude Desktop, Cursor, VS
 * Code Copilot, Zed, etc.) as `node dashboard/mcp-server.js` via the
 * client's mcp config.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = '2025-11-25';
const API_HOST = '127.0.0.1';
const API_PORT = 3800;
const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(__dirname, 'plugins');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'config.json');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'config', 'config.template.json');

// ── JSON-RPC framing ────────────────────────────────────────────────────────
const stdin = process.stdin;
const stdout = process.stdout;

stdin.setEncoding('utf8');
let buffer = '';

function send(msg) {
  stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

function log(...args) {
  // MCP stdio: stderr is free-form, usable for logs without breaking the protocol.
  process.stderr.write('[mcp-server] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
}

// ── HTTP bridge to Symphonee ─────────────────────────────────────────────
function apiRequest(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: API_HOST,
      port: API_PORT,
      path: pathname,
      method,
      headers: Object.assign(
        { 'Accept': 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      ),
    }, (res) => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode, body: parsed }));
        } else {
          resolve(parsed);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Tool registry ───────────────────────────────────────────────────────────
// Each tool has: name, description, inputSchema (JSON Schema), handler(args).
// Handlers return { content: [{ type: 'text', text: ... }] } or throw.

const TOOLS = [
  {
    name: 'save_note',
    description: 'Save a markdown note to Symphonee Notes. Returns the saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown body.' },
      },
      required: ['title', 'content'],
    },
    handler: async (args) => {
      const res = await apiRequest('POST', '/api/notes/save', { name: args.title, content: args.content });
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'spawn_worker',
    description: 'Spawn an AI worker (claude, gemini, codex, grok, copilot, qwen) with a prompt via the Symphonee orchestrator. Gated by permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: { type: 'string', enum: ['claude', 'gemini', 'codex', 'grok', 'copilot', 'qwen'] },
        prompt: { type: 'string' },
        cwd: { type: 'string', description: 'Optional working directory. Defaults to active repo.' },
        autoPermit: { type: 'boolean', description: 'Pass YOLO flag to the child CLI.', default: false },
      },
      required: ['cli', 'prompt'],
    },
    handler: async (args) => {
      const res = await apiRequest('POST', '/api/orchestrator/spawn', { from: 'mcp-client', ...args });
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'search_learnings',
    description: 'Search the Symphonee learnings database (accumulated technical knowledge and past errors).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string', enum: ['cli-flags', 'shell', 'platform', 'orchestration', 'api-pattern', 'general'] },
      },
    },
    handler: async (args) => {
      const all = await apiRequest('GET', '/api/learnings');
      let list = Array.isArray(all) ? all : [];
      if (args && args.category) list = list.filter(l => l.category === args.category);
      if (args && args.query) {
        const q = args.query.toLowerCase();
        list = list.filter(l => (l.summary || '').toLowerCase().includes(q) || (l.detail || '').toLowerCase().includes(q));
      }
      return textResult(JSON.stringify(list.slice(0, 25), null, 2));
    },
  },
  {
    name: 'list_repos',
    description: 'List all configured repositories in Symphonee (name and path).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const res = await apiRequest('GET', '/api/repos');
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'get_permission_mode',
    description: 'Read the current Symphonee permission mode and rules.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const res = await apiRequest('GET', '/api/permissions').catch(() => ({ note: 'Permissions API not available on this Symphonee version.' }));
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'start_graph_run',
    description: 'Start a durable multi-step graph run. Node types: worker (spawn a CLI), approval (human gate), branch (expression decides next path). Prompt templates use {{ state.foo }} substitution; node output auto-merges into state.results[nodeId].',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        state: { type: 'object', description: 'Initial state object.' },
        nodes: { type: 'array', items: { type: 'object' } },
      },
      required: ['nodes'],
    },
    handler: async (args) => textResult(JSON.stringify(await apiRequest('POST', '/api/graph-runs', args), null, 2)),
  },
  {
    name: 'list_graph_runs',
    description: 'List all graph runs with summary info.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => textResult(JSON.stringify(await apiRequest('GET', '/api/graph-runs'), null, 2)),
  },
  {
    name: 'get_graph_run',
    description: 'Get full detail of a graph run including state, nodes, outputs.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (args) => textResult(JSON.stringify(await apiRequest('GET', `/api/graph-runs/${encodeURIComponent(args.id)}`), null, 2)),
  },
  {
    name: 'list_recipes',
    description: 'List all available Symphonee recipes (reusable AI workflows declared as markdown files in recipes/). Defaults are pre-rendered against the current UI context.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => textResult(JSON.stringify(await apiRequest('GET', '/api/recipes'), null, 2)),
  },
  {
    name: 'get_recipe',
    description: 'Get full detail of a recipe, including its prompt body and input schema. Defaults are pre-rendered against the current UI context (same as the dashboard sees).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Recipe id (filename without .md).' } },
      required: ['id'],
    },
    handler: async (args) => textResult(JSON.stringify(await apiRequest('GET', `/api/recipes/${encodeURIComponent(args.id)}`), null, 2)),
  },
  {
    name: 'preview_recipe',
    description: 'Render a recipe with optional input overrides and return the final prompt WITHOUT running it. Useful for inspecting what the recipe would send.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        inputs: { type: 'object', description: 'Optional overrides; missing inputs use defaults.' },
      },
      required: ['id'],
    },
    handler: async (args) => textResult(JSON.stringify(await apiRequest('POST', '/api/recipes/preview', args), null, 2)),
  },
  {
    name: 'search_notes_and_learnings',
    description: 'Hybrid (BM25) search across Notes and Learnings. Returns ranked results with snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kinds: { type: 'array', items: { type: 'string', enum: ['note', 'learning'] }, description: 'Optional filter; default is both.' },
        limit: { type: 'number', default: 20 },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const params = new URLSearchParams({ q: args.query, limit: String(args.limit || 20) });
      if (args.kinds && args.kinds.length) params.set('kinds', args.kinds.join(','));
      return textResult(JSON.stringify(await apiRequest('GET', '/api/search?' + params.toString()), null, 2));
    },
  },
  {
    name: 'get_repo_map',
    description: 'Token-budgeted symbol map of a repo: languages, top-level layout, manifests, top files ranked by recent commit activity with their key symbols. Defaults to the active repo. Use this BEFORE grepping a codebase you do not know; saves tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Configured repo name. Defaults to active repo.' },
        budget: { type: 'number', default: 4000, description: 'Approximate token budget for the output.' },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.repo) params.set('repo', args.repo);
      params.set('budget', String(args.budget || 4000));
      return textResult(await apiRequest('GET', '/api/repo/map?' + params.toString()));
    },
  },
  {
    name: 'delete_recipe',
    description: 'Delete a recipe by id. Permission-gated.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (args) => textResult(JSON.stringify(await apiRequest('DELETE', `/api/recipes/${encodeURIComponent(args.id)}`), null, 2)),
  },
  {
    name: 'run_recipe',
    description: 'Run a recipe with the given inputs. Returns the spawned task id; the worker result will be injected into the originating terminal when complete.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        inputs: { type: 'object', description: 'Map of input name to value.' },
      },
      required: ['id'],
    },
    handler: async (args) => textResult(JSON.stringify(await apiRequest('POST', '/api/recipes/run', args), null, 2)),
  },
  {
    name: 'approve_graph_node',
    description: 'Resolve a pending approval node in a graph run.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        nodeId: { type: 'string' },
        approved: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['runId', 'nodeId', 'approved'],
    },
    handler: async (args) => textResult(JSON.stringify(await apiRequest('POST', `/api/graph-runs/${encodeURIComponent(args.runId)}/approve/${encodeURIComponent(args.nodeId)}`, { approved: args.approved, note: args.note }), null, 2)),
  },
];

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

// ── Plugin MCP reflection ───────────────────────────────────────────────────
// Each plugin may declare a `contributions.mcp` block in plugin.json:
//   "contributions": {
//     "mcp": {
//       "tools": [
//         { "name": "...", "description": "...", "inputSchema": {...},
//           "route": "GET /api/plugins/<id>/something",
//           "bodyFrom": "arguments"   // optional, used with POST/PATCH
//         }
//       ],
//       "resources": [ { "uri": "...", "name": "...", "mimeType": "...", "route": "GET ..." } ],
//       "prompts":   [ { "name": "...", "description": "...", "arguments": [], "route": "GET ..." } ]
//     }
//   }
// The name is namespaced as "<pluginId>__<declaredName>" so collisions are impossible.
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

function getMergedConfig() {
  const merged = { ...readJsonFile(TEMPLATE_PATH), ...readJsonFile(CONFIG_PATH) };
  if (!fs.existsSync(PLUGINS_DIR)) return merged;
  try {
    for (const dir of fs.readdirSync(PLUGINS_DIR)) {
      if (dir === 'sdk') continue;
      Object.assign(merged, readJsonFile(path.join(PLUGINS_DIR, dir, 'config.json')));
    }
  } catch (_) {}
  return merged;
}

function isPluginActiveForMcp(manifest, cfg) {
  const cond = manifest.activationConditions;
  if (!cond || cond.always) return true;
  if (Array.isArray(cond.configKeys)) return cond.configKeys.every(k => !!cfg[k]);
  return true;
}

function loadPluginContributions() {
  const tools = [];
  const resources = [];
  const prompts = [];
  if (!fs.existsSync(PLUGINS_DIR)) return { tools, resources, prompts };
  let dirs = [];
  try { dirs = fs.readdirSync(PLUGINS_DIR); } catch (_) { return { tools, resources, prompts }; }
  const cfg = getMergedConfig();
  for (const dir of dirs) {
    if (dir === 'sdk') continue;
    const manifestPath = path.join(PLUGINS_DIR, dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { continue; }
    if (!isPluginActiveForMcp(manifest, cfg)) continue;
    const mcp = manifest && manifest.contributions && manifest.contributions.mcp;
    if (!mcp) continue;
    const id = manifest.id || dir;
    for (const t of (mcp.tools || [])) {
      tools.push({
        name: `${id}__${t.name}`,
        description: `[${manifest.name || id}] ${t.description || ''}`.trim(),
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        handler: buildRouteHandler(t),
      });
    }
    for (const r of (mcp.resources || [])) {
      resources.push({
        uri: r.uri,
        name: `${manifest.name || id}: ${r.name || r.uri}`,
        description: r.description || '',
        mimeType: r.mimeType || 'application/json',
        read: buildRouteReader(r),
      });
    }
    for (const p of (mcp.prompts || [])) {
      prompts.push({
        name: `${id}__${p.name}`,
        description: `[${manifest.name || id}] ${p.description || ''}`.trim(),
        arguments: p.arguments || [],
        render: buildPromptRenderer(p),
      });
    }
  }
  return { tools, resources, prompts };
}

function parseRoute(route) {
  const i = String(route || '').indexOf(' ');
  if (i < 0) return { method: 'GET', pathname: route || '' };
  return { method: String(route).slice(0, i).toUpperCase(), pathname: String(route).slice(i + 1) };
}

function applyPathParams(pathname, args) {
  return String(pathname).replace(/:(\w+)/g, (_, key) => encodeURIComponent(args[key] != null ? args[key] : ''));
}

function buildRouteHandler(tool) {
  return async (args) => {
    const { method, pathname } = parseRoute(tool.route);
    const resolved = applyPathParams(pathname, args || {});
    let body;
    if (method === 'GET' || method === 'DELETE') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args || {})) {
        if (resolved.includes(`:${k}`)) continue;
        if (v == null) continue;
        params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      const qs = params.toString();
      const data = await apiRequest(method, resolved + (qs ? (resolved.includes('?') ? '&' : '?') + qs : ''));
      return textResult(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    }
    body = tool.bodyFrom === 'arguments' || !tool.bodyFrom ? args : (args && args[tool.bodyFrom]) || {};
    const data = await apiRequest(method, resolved, body);
    return textResult(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
}

function buildRouteReader(res) {
  return async () => {
    const { method, pathname } = parseRoute(res.route);
    return apiRequest(method || 'GET', pathname);
  };
}

function buildPromptRenderer(p) {
  return async (args) => {
    const { method, pathname } = parseRoute(p.route);
    const resolved = applyPathParams(pathname, args || {});
    const data = method === 'GET' ? await apiRequest('GET', resolved) : await apiRequest(method, resolved, args);
    if (Array.isArray(data)) return data; // assume well-formed messages
    if (data && Array.isArray(data.messages)) return data.messages;
    return [{ role: 'user', content: { type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) } }];
  };
}

// ── Resources ───────────────────────────────────────────────────────────────
const RESOURCES = [
  {
    uri: 'symphonee://context',
    name: 'Active UI context',
    description: 'Currently selected repo, iteration, and area.',
    mimeType: 'application/json',
    read: async () => apiRequest('GET', '/api/ui/context'),
  },
  {
    uri: 'symphonee://instructions',
    name: 'Symphonee instructions',
    description: 'Full API reference, workflow rules, orchestrator rules.',
    mimeType: 'text/markdown',
    read: async () => apiRequest('GET', '/api/instructions'),
  },
  {
    uri: 'symphonee://learnings',
    name: 'Learnings database',
    description: 'Accumulated technical knowledge, errors, and patterns.',
    mimeType: 'application/json',
    read: async () => apiRequest('GET', '/api/learnings'),
  },
  {
    uri: 'symphonee://permissions',
    name: 'Active permission mode and rules',
    mimeType: 'application/json',
    read: async () => apiRequest('GET', '/api/permissions'),
  },
];

// ── Prompts ─────────────────────────────────────────────────────────────────
const PROMPTS = [];

// ── Request routing ─────────────────────────────────────────────────────────
let initialized = false;

async function handleRequest(msg) {
  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      const clientProto = (params && params.protocolVersion) || PROTOCOL_VERSION;
      return sendResult(id, {
        protocolVersion: clientProto,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          prompts: { listChanged: false },
          logging: {},
        },
        serverInfo: {
          name: 'symphonee',
          version: '0.1.0',
          title: 'Symphonee MCP Server',
        },
        instructions: 'Symphonee is a shell-first workstation. Core tools manage notes, orchestration, and shell resources; installed plugins contribute provider-specific tools and prompts. All mutating tools are gated by the Symphonee permission layer.',
      });
    }

    if (method === 'notifications/initialized') {
      initialized = true;
      log('initialized');
      return; // notification, no response
    }

    if (method === 'ping') return sendResult(id, {});

    if (!initialized && method !== 'initialize') {
      return sendError(id, -32002, 'Server not initialized');
    }

    if (method === 'tools/list') {
      const plugin = loadPluginContributions();
      const all = [...TOOLS, ...plugin.tools];
      return sendResult(id, { tools: all.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }

    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const plugin = loadPluginContributions();
      const all = [...TOOLS, ...plugin.tools];
      const tool = all.find(t => t.name === name);
      if (!tool) return sendError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await tool.handler(args);
        return sendResult(id, result);
      } catch (err) {
        const body = err.body ? JSON.stringify(err.body) : String(err.message || err);
        return sendResult(id, { content: [{ type: 'text', text: `Error: ${body}` }], isError: true });
      }
    }

    if (method === 'resources/list') {
      const plugin = loadPluginContributions();
      const all = [...RESOURCES, ...plugin.resources];
      return sendResult(id, {
        resources: all.map(r => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
      });
    }

    if (method === 'resources/read') {
      const uri = params && params.uri;
      const plugin = loadPluginContributions();
      const all = [...RESOURCES, ...plugin.resources];
      const res = all.find(r => r.uri === uri);
      if (!res) return sendError(id, -32602, `Unknown resource: ${uri}`);
      try {
        const data = await res.read();
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return sendResult(id, { contents: [{ uri: res.uri, mimeType: res.mimeType, text }] });
      } catch (err) {
        return sendError(id, -32603, `Failed to read resource: ${err.message}`);
      }
    }

    if (method === 'prompts/list') {
      const plugin = loadPluginContributions();
      const all = [...PROMPTS, ...plugin.prompts];
      return sendResult(id, { prompts: all.map(p => ({ name: p.name, description: p.description, arguments: p.arguments })) });
    }

    if (method === 'prompts/get') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const plugin = loadPluginContributions();
      const all = [...PROMPTS, ...plugin.prompts];
      const p = all.find(p => p.name === name);
      if (!p) return sendError(id, -32602, `Unknown prompt: ${name}`);
      try {
        const messages = await p.render(args);
        return sendResult(id, { description: p.description, messages });
      } catch (err) {
        return sendError(id, -32603, `Failed to render prompt: ${err.message}`);
      }
    }

    return sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    return sendError(id, -32603, `Internal error: ${err.message}`);
  }
}

// ── stdin loop ──────────────────────────────────────────────────────────────
stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log('parse error:', e.message); continue; }
    if (Array.isArray(msg)) { msg.forEach(handleRequest); } else { handleRequest(msg); }
  }
});

stdin.on('end', () => { log('stdin closed, exiting'); process.exit(0); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

log(`Symphonee MCP server started (proto ${PROTOCOL_VERSION}, bridging to http://${API_HOST}:${API_PORT})`);
