/**
 * DevOps Pilot -- Model Context Protocol (MCP) server, stdio transport.
 *
 * Implements the minimum viable MCP spec:
 *   - JSON-RPC 2.0 framing (newline-delimited, stdin/stdout)
 *   - initialize / notifications/initialized lifecycle
 *   - tools/list, tools/call
 *   - resources/list, resources/read
 *   - prompts/list, prompts/get
 *
 * The server is a thin adapter: every tool call forwards to the running
 * DevOps Pilot HTTP server at 127.0.0.1:3800, which already enforces
 * permissions, caching, and business logic. If DevOps Pilot is not
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

// ── HTTP bridge to DevOps Pilot ─────────────────────────────────────────────
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
    name: 'list_work_items',
    description: 'List Azure DevOps work items for the active iteration and area. Returns id, title, state, assignedTo, type, storyPoints.',
    inputSchema: {
      type: 'object',
      properties: {
        iteration: { type: 'string', description: 'Iteration path. Omit for active iteration.' },
        state: { type: 'string', description: 'Filter by state (New, Active, Resolved, Closed).' },
        refresh: { type: 'boolean', description: 'Force refresh the cache.' },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args && args.iteration) params.set('iteration', args.iteration);
      if (args && args.refresh) params.set('refresh', '1');
      const qs = params.toString();
      const res = await apiRequest('GET', '/api/workitems' + (qs ? '?' + qs : ''));
      let items = Array.isArray(res) ? res : (res.items || res.workItems || []);
      if (args && args.state) items = items.filter(w => (w.state || '').toLowerCase() === args.state.toLowerCase());
      return textResult(JSON.stringify(items.map(w => ({
        id: w.id, title: w.title, state: w.state, type: w.type, assignedTo: w.assignedTo, storyPoints: w.storyPoints,
      })), null, 2));
    },
  },
  {
    name: 'get_work_item',
    description: 'Get full details of a single Azure DevOps work item by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Work item id.' } },
      required: ['id'],
    },
    handler: async (args) => {
      const res = await apiRequest('GET', `/api/workitems/${args.id}`);
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'create_work_item',
    description: 'Create an Azure DevOps work item. Gated by permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['User Story', 'Bug', 'Task', 'Feature', 'Epic'] },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number', enum: [1, 2, 3, 4], default: 2 },
        storyPoints: { type: 'number' },
        iterationPath: { type: 'string' },
      },
      required: ['type', 'title'],
    },
    handler: async (args) => {
      const res = await apiRequest('POST', '/api/workitems/create', args);
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'set_work_item_state',
    description: 'Change the state of a work item (New, Active, Resolved, Closed). Gated by permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        state: { type: 'string', enum: ['New', 'Active', 'Resolved', 'Closed', 'Removed'] },
      },
      required: ['id', 'state'],
    },
    handler: async (args) => {
      const res = await apiRequest('PATCH', `/api/workitems/${args.id}/state`, { state: args.state });
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'get_sprint_status',
    description: 'Current sprint overview: iteration name, work items grouped by state, completion ratio.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const ctx = await apiRequest('GET', '/api/ui/context').catch(() => ({}));
      const items = await apiRequest('GET', '/api/workitems');
      const list = Array.isArray(items) ? items : (items.items || []);
      const byState = list.reduce((acc, w) => { (acc[w.state] = acc[w.state] || []).push({ id: w.id, title: w.title, sp: w.storyPoints }); return acc; }, {});
      const totalSp = list.reduce((s, w) => s + (w.storyPoints || 0), 0);
      const closedSp = list.filter(w => ['Resolved', 'Closed'].includes(w.state)).reduce((s, w) => s + (w.storyPoints || 0), 0);
      return textResult(JSON.stringify({
        iteration: ctx.selectedIterationName || 'All Iterations',
        area: ctx.selectedAreaName || 'Team Default',
        activeRepo: ctx.activeRepo || null,
        totalItems: list.length,
        storyPoints: { total: totalSp, closed: closedSp, pct: totalSp ? Math.round(100 * closedSp / totalSp) : 0 },
        byState,
      }, null, 2));
    },
  },
  {
    name: 'save_note',
    description: 'Save a markdown note to DevOps Pilot Notes. Returns the saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown body.' },
      },
      required: ['title', 'content'],
    },
    handler: async (args) => {
      const res = await apiRequest('POST', '/api/notes', { title: args.title, content: args.content });
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'spawn_worker',
    description: 'Spawn an AI worker (claude, gemini, codex, grok, copilot) with a prompt via the DevOps Pilot orchestrator. Gated by permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: { type: 'string', enum: ['claude', 'gemini', 'codex', 'grok', 'copilot'] },
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
    description: 'Search the DevOps Pilot learnings database (accumulated technical knowledge and past errors).',
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
    description: 'List all configured repositories in DevOps Pilot (name and path).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const res = await apiRequest('GET', '/api/repos');
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'get_permission_mode',
    description: 'Read the current DevOps Pilot permission mode and rules.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const res = await apiRequest('GET', '/api/permissions').catch(() => ({ note: 'Permissions API not available on this DevOps Pilot version.' }));
      return textResult(JSON.stringify(res, null, 2));
    },
  },
  {
    name: 'start_graph_run',
    description: 'BETA. Start a durable multi-step graph run. Requires GraphRunsMode enabled in Settings -> Other. Node types: worker (spawn a CLI), approval (human gate), branch (expression decides next path). Prompt templates use {{ state.foo }} substitution; node output auto-merges into state.results[nodeId].',
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
    description: 'BETA. List all graph runs with summary info.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => textResult(JSON.stringify(await apiRequest('GET', '/api/graph-runs'), null, 2)),
  },
  {
    name: 'get_graph_run',
    description: 'BETA. Get full detail of a graph run including state, nodes, outputs.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (args) => textResult(JSON.stringify(await apiRequest('GET', `/api/graph-runs/${encodeURIComponent(args.id)}`), null, 2)),
  },
  {
    name: 'approve_graph_node',
    description: 'BETA. Resolve a pending approval node in a graph run.',
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
function loadPluginContributions() {
  const tools = [];
  const resources = [];
  const prompts = [];
  if (!fs.existsSync(PLUGINS_DIR)) return { tools, resources, prompts };
  let dirs = [];
  try { dirs = fs.readdirSync(PLUGINS_DIR); } catch (_) { return { tools, resources, prompts }; }
  for (const dir of dirs) {
    if (dir === 'sdk') continue;
    const manifestPath = path.join(PLUGINS_DIR, dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { continue; }
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
    uri: 'devops-pilot://context',
    name: 'Active UI context',
    description: 'Currently selected repo, iteration, and area.',
    mimeType: 'application/json',
    read: async () => apiRequest('GET', '/api/ui/context'),
  },
  {
    uri: 'devops-pilot://instructions',
    name: 'DevOps Pilot instructions',
    description: 'Full API reference, workflow rules, orchestrator rules.',
    mimeType: 'text/markdown',
    read: async () => apiRequest('GET', '/api/instructions'),
  },
  {
    uri: 'devops-pilot://learnings',
    name: 'Learnings database',
    description: 'Accumulated technical knowledge, errors, and patterns.',
    mimeType: 'application/json',
    read: async () => apiRequest('GET', '/api/learnings'),
  },
  {
    uri: 'devops-pilot://permissions',
    name: 'Active permission mode and rules',
    mimeType: 'application/json',
    read: async () => apiRequest('GET', '/api/permissions'),
  },
];

// ── Prompts ─────────────────────────────────────────────────────────────────
const PROMPTS = [
  {
    name: 'standup_summary',
    description: 'Generate a daily standup summary from recent work item activity.',
    arguments: [{ name: 'iteration', description: 'Iteration path (optional).', required: false }],
    render: async (args) => {
      const iter = args && args.iteration ? `?iteration=${encodeURIComponent(args.iteration)}` : '';
      const items = await apiRequest('GET', '/api/workitems' + iter).catch(() => []);
      const list = Array.isArray(items) ? items : (items.items || []);
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Write a concise daily standup summary based on these Azure DevOps work items. Group by engineer. Call out blockers and items stalled for more than 2 days.\n\n${JSON.stringify(list, null, 2)}`,
          },
        },
      ];
    },
  },
  {
    name: 'retro_analysis',
    description: 'Generate a sprint retrospective starter from closed and carried-over items.',
    arguments: [],
    render: async () => {
      const items = await apiRequest('GET', '/api/workitems').catch(() => []);
      const list = Array.isArray(items) ? items : (items.items || []);
      const closed = list.filter(w => ['Resolved', 'Closed'].includes(w.state));
      const open = list.filter(w => ['New', 'Active'].includes(w.state));
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Produce a sprint retrospective in three sections: What went well, What did not go well, Action items. Base it on these work items.\n\nClosed (${closed.length}):\n${JSON.stringify(closed, null, 2)}\n\nStill open (${open.length}):\n${JSON.stringify(open, null, 2)}`,
          },
        },
      ];
    },
  },
];

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
          name: 'devops-pilot',
          version: '0.1.0',
          title: 'DevOps Pilot MCP Server',
        },
        instructions: 'DevOps Pilot is an Azure DevOps workstation. Tools perform work item management, sprint queries, orchestrator spawns, and notes. Resources expose live UI context, instructions, learnings, and the active permission mode. All mutating tools are gated by the DevOps Pilot permission layer.',
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

log(`DevOps Pilot MCP server started (proto ${PROTOCOL_VERSION}, bridging to http://${API_HOST}:${API_PORT})`);
