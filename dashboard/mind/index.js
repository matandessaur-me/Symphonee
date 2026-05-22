/**
 * Mind - Symphonee's shared knowledge graph.
 *
 * The brain belongs to Symphonee, not to any one CLI. Every dispatched AI
 * worker (Claude Code, Codex, Gemini, Copilot, Grok, Qwen) reads from and
 * writes to the same graph through this REST surface.
 *
 * mountMind(addRoute, json, ctx) registers all /api/mind/* routes and
 * exports lifecycle hooks the rest of the server uses (bootstrap field,
 * orchestrator hint injection, Q&A feedback loop).
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Manifest } = require('./manifest');
const engine = require('./engine');
const query = require('./query');
const { cluster } = require('./cluster');
const { analyze } = require('./analyze');
const { composeWakeUp, DEFAULT_BUDGET_TOKENS } = require('./wakeup');
const { sanitizeLabel, validateUrl } = require('./security');
const { MindWatcher } = require('./watch');
const { reflectOnce, startReflectionScheduler } = require('./reflect');
const { healOnce, startHealingScheduler } = require('./heal');
const insights = require('./insights');
const repeatedQuestionAnalyser = require('./analysers/repeated-question');
const coEditAnalyser = require('./analysers/co-edit');
const memoryDecayAnalyser = require('./analysers/memory-decay');
const crossRepoAnalyser = require('./analysers/cross-repo');
const memoryModule = require('./memory');
const ollamaSetup = require('./ollama-setup');
const llm = require('./llm');
const lock = require('./lock');
const checkpoint = require('./checkpoint');
const impact = require('./impact');
const embeddings = require('./embeddings');
const { VectorStore } = require('./vectors');
const viz = require('./viz');

// In-memory job table for build/update progress. Jobs are ephemeral; the
// canonical graph on disk is the system of record.
const jobs = new Map();
const DEFAULT_BUILD_SOURCES = ['notes', 'learnings', 'cli-memory', 'cli-skills', 'recipes', 'app-recipes', 'site-map', 'plugins', 'instructions', 'repo-code', 'cli-history', 'cli-drawers', 'context-artifacts', 'repos', 'entities'];
function makeJobId() { return 'mj_' + Math.random().toString(36).slice(2, 10); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function tryDenseSeeds(repoRoot, space, question, k = 50) {
  const vs = new VectorStore(repoRoot, space);
  if (!vs.load() || vs.count() === 0) return null;
  const provider = vs.provider || process.env.SYMPHONEE_EMBED_PROVIDER || embeddings.pickProvider();
  if (!provider) return null;
  let qv;
  try {
    qv = await embeddings.embedSingle(question, { provider, model: vs.model || undefined });
  } catch (_) {
    return null;
  }
  if (!qv) return null;
  return vs.query(qv, k);
}

function mountMind(addRoute, json, ctx) {
  const { repoRoot, getUiContext, getLearnings, getPlugins, getNotesDir, broadcast, getAiApiKeys, getConfig } = ctx;
  // Make the user's configured API keys available to the embedding layer so
  // it can pick a provider automatically (OpenAI > Google) instead of
  // defaulting to Ollama. Refreshes on every request so config edits take
  // effect without a restart.
  function refreshEmbedKeys() {
    // Keys still flow through in case the orchestrator/other features
    // call embed() with an explicit provider, but the default picker is
    // hard-locked to Ollama-or-nothing.
    try { embeddings.setAvailableApiKeys(getAiApiKeys ? getAiApiKeys() : {}); } catch (_) {}
  }
  refreshEmbedKeys();
  // Probe Ollama at boot + every 5 min so the picker prefers local
  // semantic search the moment Ollama becomes available (no restart
  // required). Failure is silent — falls back to BM25.
  embeddings.refreshOllamaStatus({ force: true }).catch(() => {});
  setInterval(() => { embeddings.refreshOllamaStatus().catch(() => {}); }, 5 * 60 * 1000).unref();
  // Same cadence for the chat-model probe so reflection wakes up the
  // instant a chat model gets pulled (whether by auto-bootstrap or by
  // the user running `ollama pull` manually).
  llm.refreshChatStatus({ force: true }).catch(() => {});
  setInterval(() => { llm.refreshChatStatus().catch(() => {}); }, 5 * 60 * 1000).unref();

  const getSpace = () => {
    const c = getUiContext ? getUiContext() : {};
    return c.activeSpace || c.notesNamespace || '_global';
  };

  function persistDerivedGraph(space, graph) {
    const next = graph || store.emptyGraph({ space });
    next.version = next.version || 1;
    next.scope = next.scope || { space, isGlobal: false };
    const { communities } = cluster(next);
    const { gods, surprises, suggested } = analyze({ ...next, communities });
    next.communities = communities;
    next.gods = gods;
    next.surprises = surprises;
    next.suggested = suggested;
    return store.saveGraph(repoRoot, space, next);
  }

  // ── Knowledge-event hook (the brain reacts) ──────────────────────────────
  //
  // Anything that adds a node to the graph from a non-file source
  // (save-result, teach, /add, learnings, manual ingest) should call
  // notifyKnowledgeEvent so Mind does the same incremental rebuild +
  // per-node embed it would do for a file change.
  //
  // Debounced separately from the file watcher: knowledge writes burst
  // (one save-result -> N memory cards -> N embeds), so we coalesce a
  // 3s window before re-clustering / re-embedding.
  let knowledgeTimer = null;
  const pendingNodes = new Set();
  let pendingReasons = new Set();
  let lastEventAt = 0;
  const getLastEventAt = () => lastEventAt;

  async function embedSingleNode(space, nodeId) {
    refreshEmbedKeys();
    const vs = new VectorStore(repoRoot, space);
    const loaded = vs.load();
    // Only embed if a vector store already exists for this space — we
    // never want a single new node to spin up a brand-new store with
    // dim 0. The full /api/mind/embed run owns initialisation.
    if (!loaded || vs.count() === 0) return { ok: false, reason: 'no-vector-store' };
    const g = store.loadGraph(repoRoot, space);
    if (!g) return { ok: false, reason: 'no-graph' };
    const node = g.nodes.find(n => n.id === nodeId);
    if (!node) return { ok: false, reason: 'node-missing' };
    const text = [node.label, node.body, node.answer].filter(Boolean).join('\n\n').slice(0, 4000);
    if (!text.trim()) return { ok: false, reason: 'no-text' };
    const provider = vs.provider || embeddings.pickProvider();
    if (!provider) return { ok: false, reason: 'no-provider' };
    try {
      const vec = await embeddings.embedSingle(text, { provider, model: vs.model || undefined });
      if (!vec) return { ok: false, reason: 'empty-embedding' };
      vs.upsert(nodeId, vec);
      vs.save();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'embed-error', error: err.message };
    }
  }

  function notifyKnowledgeEvent({ kind, nodeIds = [], reason }) {
    lastEventAt = Date.now();
    for (const id of nodeIds) pendingNodes.add(id);
    if (reason) pendingReasons.add(reason);
    if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'knowledge-event', reason: kind || reason, nodeCount: nodeIds.length } });
    // Out-of-band hook for layers above Mind (the brain feeds intent +
    // sequence recorder from here). Must never throw or block.
    if (typeof ctx.onKnowledgeEvent === 'function') {
      try { ctx.onKnowledgeEvent({ kind, reason, nodeIds }); } catch (_) { /* swallow */ }
    }
    if (knowledgeTimer) clearTimeout(knowledgeTimer);
    knowledgeTimer = setTimeout(async () => {
      const ids = Array.from(pendingNodes);
      const reasons = Array.from(pendingReasons);
      pendingNodes.clear();
      pendingReasons.clear();
      knowledgeTimer = null;
      const space = getSpace();
      // Auto-embed every new node we know about. Independent of the
      // full incremental build below — the per-node embed is cheap and
      // gives semantic recall an immediate signal.
      for (const id of ids) {
        try { await embedSingleNode(space, id); } catch (_) { /* one bad embed must not block the rest */ }
      }
      // Same incremental rebuild the file watcher fires. Picks up any
      // sources that may have changed alongside the knowledge event
      // (e.g. a note that was edited in the same turn).
      try {
        await triggerIncrementalUpdate({ knowledgeEvent: true, reasons, nodeIds: ids });
      } catch (e) {
        console.warn('[mind/knowledge-event] update error:', e.message);
      }
    }, 3000);
  }

  // ── Reads ────────────────────────────────────────────────────────────────
  addRoute('GET', '/api/mind/graph', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { space, empty: true, nodes: [], edges: [] });
    return json(res, g);
  });

  addRoute('GET', '/api/mind/stats', (req, res) => {
    const space = getSpace();
    const stats = store.statsFor(repoRoot, space);
    return json(res, { space, stats });
  });

  // ── Mind-aware CLI routing suggestion ────────────────────────────────────
  //
  // Returns a CLI ranking based on which CLIs have previously completed
  // similar tasks successfully. Pulls conversation/task nodes whose label
  // overlaps with the prompt (BM25), groups by `createdBy` (the CLI), and
  // weights by recency.
  //
  // This is ADVISORY. The model-router script is still authoritative for
  // intent-based routing; this answers a different question:
  // "for THIS specific task, who has been on it before?"
  //
  // Multi-CLI: every CLI Symphonee supports can appear in the ranking.
  // If a CLI has never completed a similar task, it simply doesn't appear
  // — that's not a vote against it, just absence of evidence.
  addRoute('POST', '/api/mind/suggest-cli', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const { question, prompt, limit = 5 } = body;
    const q = question || prompt;
    if (!q) return json(res, { error: 'question or prompt required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { suggestions: [], note: 'graph empty' });

    const seedIds = query.bestSeeds(g, q, 20);
    if (!seedIds.length) return json(res, { suggestions: [], note: 'no similar tasks in brain yet' });

    // Among seeded nodes, look for conversation/qa/task nodes carrying a CLI.
    const now = Date.now();
    const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const perCli = new Map();
    for (const sid of seedIds) {
      const n = g.nodes.find(x => x.id === sid);
      if (!n) continue;
      if (n.kind !== 'conversation' && n.kind !== 'drawer') continue;
      const cli = n.createdBy;
      if (!cli || cli === 'system' || cli === 'orchestrator' || cli === 'unknown') continue;
      const age = n.createdAt ? Math.max(0, now - new Date(n.createdAt).getTime()) : halfLifeMs;
      const recencyScore = Math.exp(-age / halfLifeMs);
      const slot = perCli.get(cli) || { cli, count: 0, score: 0, latest: null, examples: [] };
      slot.count += 1;
      slot.score += recencyScore;
      if (!slot.latest || (n.createdAt && n.createdAt > slot.latest)) slot.latest = n.createdAt || slot.latest;
      if (slot.examples.length < 3) slot.examples.push({ id: n.id, label: (n.label || '').slice(0, 80), createdAt: n.createdAt });
      perCli.set(cli, slot);
    }
    const suggestions = Array.from(perCli.values()).sort((a, b) => b.score - a.score).slice(0, limit);
    return json(res, {
      question: q.slice(0, 200),
      suggestions,
      note: suggestions.length ? 'advisory only; model-router still authoritative for intent-based picks' : 'no past CLI activity for similar tasks',
    });
  });

  // ── Wake-up (L0+L1 layered context for prompt injection) ─────────────────
  addRoute('GET', '/api/mind/wakeup', (req, res) => {
    const space = getSpace();
    const ui = getUiContext ? getUiContext() : {};
    const url = new URL(req.url, 'http://x');
    const budget = parseInt(url.searchParams.get('budget') || '', 10);
    const question = url.searchParams.get('question') || '';
    const g = store.loadGraph(repoRoot, space) || { nodes: [], edges: [], gods: [] };
    const wake = composeWakeUp(g, {
      activeRepo: ui.activeRepo, activeRepoPath: ui.activeRepoPath, space,
      budgetTokens: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_TOKENS,
      question,
      repoRoot,
    });
    return json(res, { space, ...wake });
  });

  addRoute('GET', '/api/mind/node', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (!id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'no graph' }, 404);
    const node = g.nodes.find(n => n.id === id);
    if (!node) return json(res, { error: 'not found' }, 404);
    const neighbors = [];
    for (const e of g.edges) {
      if (e.source === id) neighbors.push({ direction: 'out', edge: e, peer: g.nodes.find(n => n.id === e.target) });
      else if (e.target === id) neighbors.push({ direction: 'in', edge: e, peer: g.nodes.find(n => n.id === e.source) });
    }
    return json(res, { node, neighbors, communityId: node.communityId ?? null });
  });

  addRoute('GET', '/api/mind/community', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'no graph' }, 404);
    if (id == null) return json(res, { communities: g.communities || {} });
    const c = g.communities?.[id];
    if (!c) return json(res, { error: 'community not found' }, 404);
    const nodes = c.nodeIds.map(nid => g.nodes.find(n => n.id === nid)).filter(Boolean);
    return json(res, { id, ...c, nodes });
  });

  addRoute('GET', '/api/mind/gods', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { gods: [] });
    return json(res, { gods: g.gods || [] });
  });

  addRoute('GET', '/api/mind/surprises', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { surprises: [] });
    return json(res, { surprises: g.surprises || [] });
  });

  addRoute('GET', '/api/mind/jobs', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (id) {
      const j = jobs.get(id);
      if (!j) return json(res, { error: 'not found' }, 404);
      return json(res, j);
    }
    return json(res, { jobs: Array.from(jobs.values()).slice(-50) });
  });

  addRoute('GET', '/api/mind/instructions', (req, res) => {
    const p = path.join(__dirname, 'instructions.md');
    try { res.writeHead(200, { 'Content-Type': 'text/markdown' }); res.end(fs.readFileSync(p)); }
    catch (e) { json(res, { error: e.message }, 500); }
  });

  // ── Builds ───────────────────────────────────────────────────────────────
  addRoute('POST', '/api/mind/build', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const sources = body.sources || DEFAULT_BUILD_SOURCES;

    // Concurrency guard - if a build is already running, return 409 instead of
    // racing two builds against the same graph.json.
    const existing = lock.status(space, 'graph');
    if (existing.locked) {
      return json(res, {
        error: 'build already running',
        holderPid: existing.holderPid,
        ageMs: existing.ageMs,
      }, 409);
    }

    const jobId = makeJobId();
    const job = { id: jobId, kind: 'build', space, sources, status: 'running', startedAt: Date.now(), progress: [] };
    jobs.set(jobId, job);
    if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'build-start', jobId, space, sources } });
    json(res, { jobId, space, sources });
    // Run async so the response returns immediately
    Promise.resolve().then(() => engine.runBuild({
      repoRoot, space, sources, ctx,
      onProgress: (msg) => {
        job.progress.push({ ts: Date.now(), msg });
        if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'build-progress', jobId, msg } });
      },
    })).then((result) => {
      job.status = 'completed';
      job.completedAt = Date.now();
      job.result = result;
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'build-complete', jobId, result } });
      if (broadcast && result && result.validationWarningCount) {
        broadcast({
          type: 'notification',
          title: 'Mind build completed with skipped graph data',
          body: `${result.validationWarningCount} invalid graph item(s) were skipped. The rest of the graph was saved.`,
          level: 'warning',
          icon: 'alert-triangle',
        });
      }
    }).catch((err) => {
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = err.message;
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'build-failed', jobId, error: err.message } });
    });
  });

  addRoute('POST', '/api/mind/update', async (req, res) => {
    // Incremental: same engine, but engine consults manifest to skip unchanged
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const sources = body.sources || DEFAULT_BUILD_SOURCES;

    const existing = lock.status(space, 'graph');
    if (existing.locked) {
      return json(res, { error: 'update already running', holderPid: existing.holderPid, ageMs: existing.ageMs }, 409);
    }

    const jobId = makeJobId();
    const job = { id: jobId, kind: 'update', space, sources, status: 'running', startedAt: Date.now(), progress: [] };
    jobs.set(jobId, job);
    json(res, { jobId, space, sources });
    Promise.resolve().then(() => engine.runBuild({
      repoRoot, space, sources, incremental: true, ctx,
      onProgress: (msg) => job.progress.push({ ts: Date.now(), msg }),
    })).then((result) => {
      job.status = 'completed'; job.completedAt = Date.now(); job.result = result;
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'update-complete', jobId, result } });
      if (broadcast && result && result.validationWarningCount) {
        broadcast({
          type: 'notification',
          title: 'Mind update completed with skipped graph data',
          body: `${result.validationWarningCount} invalid graph item(s) were skipped. The rest of the graph was saved.`,
          level: 'warning',
          icon: 'alert-triangle',
        });
      }
    }).catch((err) => {
      job.status = 'failed'; job.completedAt = Date.now(); job.error = err.message;
    });
  });

  // ── Lock + checkpoint introspection ──────────────────────────────────────
  addRoute('GET', '/api/mind/lock', (req, res) => {
    const space = getSpace();
    return json(res, {
      space,
      build: lock.status(space, 'build'),
      update: lock.status(space, 'update'),
      graph: lock.status(space, 'graph'),
      watch: lock.status(space, 'watch'),
      all: lock.listAll(),
    });
  });

  addRoute('POST', '/api/mind/lock/clear', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const op = body.op || 'graph';
    const r = lock.terminateHolder(space, op);
    return json(res, { space, op, ...r });
  });

  addRoute('GET', '/api/mind/checkpoint', (req, res) => {
    const space = getSpace();
    const cp = checkpoint.read(repoRoot, space);
    return json(res, { space, checkpoint: cp });
  });

  // ── Impact / call-flow / symbols / entrypoints / circular ───────────────
  // The "Mind got smarter" surface. Every endpoint reads the persisted graph
  // and computes on demand - no extra storage. Cheap because the graph is
  // already in memory after the first read.
  addRoute('POST', '/api/mind/impact', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const target = body.target || body.symbol || body.file;
    const depth = Number.isFinite(body.depth) ? body.depth : 3;
    if (!target) return json(res, { error: 'target required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    return json(res, impact.getImpact(g, String(target), depth));
  });

  addRoute('POST', '/api/mind/flow', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const entry = body.entrypoint || body.target;
    const depth = Number.isFinite(body.depth) ? body.depth : 5;
    if (!entry) return json(res, { error: 'entrypoint required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const flow = impact.getCallFlow(g, String(entry), depth);
    if (!flow) return json(res, { error: 'entrypoint not found' }, 404);
    return json(res, { entrypoint: String(entry), depth, flow });
  });

  addRoute('POST', '/api/mind/symbol', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.name) return json(res, { error: 'name required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    return json(res, { name: body.name, results: impact.getSymbolContext(g, body.name, body.file) });
  });

  addRoute('POST', '/api/mind/symbols', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    return json(res, {
      results: impact.listSymbols(g, {
        file: body.file,
        query: body.query,
        limit: Number.isFinite(body.limit) ? body.limit : 200,
      }),
    });
  });

  addRoute('POST', '/api/mind/entrypoints', async (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    return json(res, { entrypoints: impact.detectEntrypoints(g) });
  });

  addRoute('POST', '/api/mind/circular', async (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const cycles = impact.detectCircular(g);
    return json(res, { count: cycles.length, cycles });
  });

  // ── File-level browsing for the Impact UI ───────────────────────────────
  // The symbol-level call graph is approximate (regex-based) so its results
  // are noisy. The file-import graph is comprehensive and reliable. This
  // endpoint exposes it: a list of every code file with its imports +
  // dependents counts so the UI can build a file-first browser.
  addRoute('POST', '/api/mind/files', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);

    // Build adjacency for 'imports' edges only.
    const incoming = new Map();
    const outgoing = new Map();
    for (const e of g.edges) {
      if (e.relation !== 'imports') continue;
      if (!outgoing.has(e.source)) outgoing.set(e.source, []);
      if (!incoming.has(e.target)) incoming.set(e.target, []);
      outgoing.get(e.source).push(e.target);
      incoming.get(e.target).push(e.source);
    }

    const files = [];
    for (const n of g.nodes) {
      if (n.kind !== 'code') continue;
      if (!n.source || n.source.type !== 'file') continue;
      const rel = n.source.ref || (n.sourceLocation && n.sourceLocation.file) || n.label;
      files.push({
        id: n.id,
        path: rel,
        label: n.label,
        importsCount: (outgoing.get(n.id) || []).length,
        dependentsCount: (incoming.get(n.id) || []).length,
        unresolvedImports: (outgoing.get(n.id) || []).filter(t => String(t).startsWith('ext_')).length,
      });
    }
    files.sort((a, b) => (b.dependentsCount + b.importsCount) - (a.dependentsCount + a.importsCount));

    if (body.path) {
      const target = files.find(f => f.path === body.path || f.id === body.path);
      if (!target) return json(res, { error: 'file not found', total: files.length });
      const idToFile = new Map(files.map(f => [f.id, f]));
      const importsList = (outgoing.get(target.id) || []).map(id => idToFile.get(id) || { id, path: id, external: String(id).startsWith('ext_') });
      const dependentsList = (incoming.get(target.id) || []).map(id => idToFile.get(id) || { id, path: id });
      // Symbols inside this file (best-effort)
      const symbols = g.nodes.filter(n => n.kind === 'code' && n.source && n.source.type === 'symbol' && (n.source.file === target.path || (n.sourceLocation && n.sourceLocation.file === target.path)));
      return json(res, {
        file: target,
        imports: importsList.slice(0, 200),
        dependents: dependentsList.slice(0, 200),
        symbols: symbols.map(s => ({ id: s.id, name: s.label, line: s.sourceLocation && s.sourceLocation.line || null })),
      });
    }
    return json(res, {
      total: files.length,
      files: files.slice(0, body.limit || 2000),
    });
  });

  // ── Per-file patch (incremental update for a single saved file) ─────────
  // Cheaper than /api/mind/update for the common "user just saved one file"
  // case. Invalidates the manifest entry for that file so the next
  // incremental build re-extracts it. The actual re-extraction still goes
  // through engine.runBuild incremental=true so all the plumbing
  // (sources, dedup, locks, save) stays in one place.
  addRoute('POST', '/api/mind/patch-file', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const file = body.file;
    if (!file) return json(res, { error: 'file required' }, 400);
    const space = getSpace();

    const ui = getUiContext ? getUiContext() : {};
    const repoPath = ui.activeRepoPath;
    if (!repoPath) return json(res, { error: 'no active repo' }, 400);
    const rel = path.isAbsolute(file)
      ? path.relative(repoPath, file).replace(/\\/g, '/')
      : file.replace(/\\/g, '/');

    // Drop the file from the manifest so the next incremental build
    // re-extracts it from disk.
    try {
      const m = new Manifest(repoRoot, space);
      m.delete(rel);
      m.flushSync();
    } catch (e) {
      return json(res, { error: 'manifest update failed: ' + e.message }, 500);
    }

    const acq = lock.acquire(space, 'patch-file');
    if (!acq.ok) return json(res, { error: 'patch-file already running', holderPid: acq.holderPid }, 409);
    const jobId = makeJobId();
    json(res, { jobId, ok: true, file: rel });

    Promise.resolve().then(() => engine.runBuild({
      repoRoot, space, sources: ['repo-code'], incremental: true, ctx,
      onProgress: () => {},
    })).then((result) => {
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'patch-file-complete', jobId, file: rel, result } });
    }).catch((err) => {
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'patch-file-failed', jobId, file: rel, error: err.message } });
    }).finally(() => {
      lock.release(space, 'patch-file');
    });
  });

  // ── Visualisation (mermaid text + interactive HTML viewer) ──────────────
  addRoute('POST', '/api/mind/visualize', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const mode = (body.mode || 'mermaid').toLowerCase();
    if (mode === 'mermaid') {
      return json(res, { mode, mermaid: viz.mermaidGraph(g, { focus: body.focus || null, max: body.max || 200 }) });
    }
    if (mode === 'interactive') {
      const opts = { focus: body.focus || null, layout: body.layout || 'cose', title: `Mind: ${space}` };
      if (body.inline) {
        const html = viz.interactiveHtml(g, opts);
        return json(res, { mode, html, openIn: 'inline' });
      }
      const out = viz.writeInteractive(g, opts);
      return json(res, { mode, ...out, openIn: 'webview' });
    }
    return json(res, { error: 'mode must be mermaid or interactive' }, 400);
  });

  // ── Context artifacts (declared in .symphonee/context-artifacts.json) ──
  addRoute('POST', '/api/mind/artifacts/list', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const ui = getUiContext ? getUiContext() : {};
    const allRepos = (typeof ctx.getAllRepos === 'function' ? (ctx.getAllRepos() || {}) : {});
    const { readArtifactsConfig } = require('./extractors/context-artifacts');
    const fs = require('fs');

    // Always-global pass: read declared artifacts from EVERY repo Symphonee
    // knows about. Mind is global, so artifacts surface from all repos
    // unless the caller explicitly asks scope:'active'.
    const scope = body.scope || 'all';
    const repos = [];
    if (scope === 'active') {
      if (ui.activeRepo && ui.activeRepoPath) repos.push({ name: ui.activeRepo, path: ui.activeRepoPath });
    } else {
      for (const [name, p] of Object.entries(allRepos)) if (p) repos.push({ name, path: p });
      if (ui.activeRepo && ui.activeRepoPath && !repos.find(r => r.name === ui.activeRepo)) {
        repos.unshift({ name: ui.activeRepo, path: ui.activeRepoPath });
      }
    }

    const g = store.loadGraph(repoRoot, space);
    const indexedByKey = new Map();
    if (g) {
      for (const n of g.nodes) {
        if (n.kind !== 'artifact') continue;
        if (!n.source || n.source.type !== 'artifact') continue;
        indexedByKey.set(`${n.source.root || ''}::${n.label}`, n);
      }
    }

    const groups = repos.map(r => {
      const cfg = readArtifactsConfig(r.path, repoRoot);
      const enriched = (cfg.artifacts || []).map(a => {
        const indexed = indexedByKey.get(`${r.path || ''}::${a.name}`);
        return {
          name: a.name,
          path: a.path,
          description: a.description || '',
          indexed: !!indexed,
          fileCount: indexed?.fileCount || 0,
        };
      });
      return {
        repo: r.name,
        repoPath: r.path,
        configPath: cfg.configPath,
        configExists: !!cfg.configPath && fs.existsSync(cfg.configPath),
        error: cfg.error || null,
        artifacts: enriched,
      };
    });

    // Backwards-compat: keep top-level fields for the active repo so any
    // existing caller doesn't break.
    const active = groups.find(g => g.repo === ui.activeRepo) || groups[0] || {};
    return json(res, {
      space,
      scope,
      groups,
      // legacy shape:
      configPath: active.configPath || null,
      configExists: !!active.configExists,
      error: active.error || null,
      artifacts: active.artifacts || [],
    });
  });

  const ARTIFACT_PATTERNS = [
    { name: 'database-schema', candidates: ['schema.sql', 'docs/schema.sql', 'db/schema.sql', 'prisma/schema.prisma', 'db/schema.rb', 'database.sql'], description: 'Database schema. Check before writing migrations to match column conventions, FK rules, and trigger patterns.' },
    { name: 'api-spec',        candidates: ['openapi.yaml', 'openapi.yml', 'openapi.json', 'docs/openapi.yaml', 'api/openapi.yaml', 'swagger.yaml', 'swagger.json'], description: 'OpenAPI / Swagger spec. Check before adding or modifying endpoints to match auth, pagination, and response-envelope conventions.' },
    { name: 'graphql-schema',  candidates: ['schema.graphql', 'docs/schema.graphql', 'graphql/schema.graphql'], description: 'GraphQL schema. Check before adding queries / mutations to keep types consistent.' },
    { name: 'adrs',            candidates: ['docs/adr', 'docs/adr/', 'adr/', '.adr/', 'docs/decisions/'], description: 'Architecture Decision Records. Check before introducing a new pattern - we may have rejected this approach already.' },
    { name: 'readme',          candidates: ['README.md', 'README'], description: 'Project README. Quick orientation - what this repo does, conventions, how to run.' },
    { name: 'claude-md',       candidates: ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.windsurfrules'], description: 'Repo-level AI rules. Tells the AI how to behave inside this codebase. Always consulted at session start.' },
    { name: 'docs',            candidates: ['docs/', 'documentation/'], description: 'Project documentation. Check for design notes, conventions, and onboarding info.' },
    { name: 'ubiquitous-language', candidates: ['docs/ubiquitous-language.md', 'docs/glossary.md', 'GLOSSARY.md', 'docs/GLOSSARY.md'], description: 'Domain glossary. Always check before naming entities, events, or commands so we use the correct domain terms.' },
    { name: 'package-json',    candidates: ['package.json'], description: 'Top-level package manifest. Check for tech stack, scripts, dependencies before suggesting changes.' },
    { name: 'tsconfig',        candidates: ['tsconfig.json', 'jsconfig.json'], description: 'TypeScript / JS path aliases + compiler options. Check before introducing new path conventions.' },
  ];

  function _scanRepoArtifacts(root) {
    const fs = require('fs');
    const path = require('path');
    if (!root || !fs.existsSync(root)) return [];
    function exists(rel) { try { return fs.existsSync(path.join(root, rel)); } catch (_) { return false; } }
    function isDir(rel) { try { return fs.statSync(path.join(root, rel)).isDirectory(); } catch (_) { return false; } }
    const out = [];
    for (const p of ARTIFACT_PATTERNS) {
      const found = p.candidates.find(c => exists(c) && (c.endsWith('/') ? isDir(c) : true));
      if (found) out.push({ name: p.name, path: './' + found.replace(/\/$/, ''), description: p.description });
    }
    return out;
  }

  // Auto-detect likely artifacts. Mind is global - the brain ingests every
  // repo Symphonee manages - so artifact detection runs across ALL repos by
  // default. Pass `scope: 'active'` to limit to the active repo.
  addRoute('POST', '/api/mind/artifacts/suggest', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const ui = getUiContext ? getUiContext() : {};
    const allRepos = (typeof ctx.getAllRepos === 'function' ? (ctx.getAllRepos() || {}) : {});
    const scope = body.scope || 'all';
    const repos = [];
    if (scope === 'active') {
      if (ui.activeRepo && ui.activeRepoPath) repos.push({ name: ui.activeRepo, path: ui.activeRepoPath });
    } else {
      for (const [name, p] of Object.entries(allRepos)) {
        if (p) repos.push({ name, path: p });
      }
      // ensure the active repo is in the list even if not in cfg.Repos
      if (ui.activeRepo && ui.activeRepoPath && !repos.find(r => r.name === ui.activeRepo)) {
        repos.unshift({ name: ui.activeRepo, path: ui.activeRepoPath });
      }
    }

    const groups = repos.map(r => ({
      repo: r.name,
      repoPath: r.path,
      hasConfigFile: require('fs').existsSync(require('path').join(r.path, '.symphonee', 'context-artifacts.json')),
      suggestions: _scanRepoArtifacts(r.path),
    }));
    return json(res, { scope, groups });
  });

  // Write a starter .symphonee/context-artifacts.json. Defaults to the
  // active repo; pass `repo: <name>` (or `repoPath`) to write into a
  // different one.
  addRoute('POST', '/api/mind/artifacts/init', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const ui = getUiContext ? getUiContext() : {};
    const allRepos = (typeof ctx.getAllRepos === 'function' ? (ctx.getAllRepos() || {}) : {});
    let root = body.repoPath;
    if (!root && body.repo) root = allRepos[body.repo] || null;
    if (!root) root = ui.activeRepoPath;
    if (!root) return json(res, { error: 'no repo path resolved', hint: 'pass repo: <name> or repoPath: <abs>' }, 400);
    const fs = require('fs');
    const path = require('path');
    const target = path.join(root, '.symphonee', 'context-artifacts.json');
    if (fs.existsSync(target) && !body.overwrite) {
      return json(res, { error: 'context-artifacts.json already exists', path: target }, 409);
    }
    const artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
    if (!artifacts.length) {
      return json(res, { error: 'no artifacts provided' }, 400);
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const cleaned = artifacts.map(a => ({ name: a.name, path: a.path, description: a.description || '' }));
      fs.writeFileSync(target, JSON.stringify({ artifacts: cleaned }, null, 2), 'utf8');
      return json(res, { ok: true, path: target, repoPath: root, count: cleaned.length });
    } catch (e) {
      return json(res, { error: 'write failed: ' + e.message }, 500);
    }
  });

  addRoute('POST', '/api/mind/artifacts/search', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const q = String(body.q || body.query || '').trim();
    const name = body.name || null;
    let pool = g.nodes.filter(n => n.kind === 'artifact');
    if (name) pool = pool.filter(n => Array.isArray(n.tags) && n.tags.includes(`artifact:${name}`));
    if (!pool.length) return json(res, { q, name, results: [] });
    if (!q) {
      return json(res, { q, name, results: pool.slice(0, 30).map(n => ({ id: n.id, label: n.label, file: n.sourceLocation?.file || null, description: n.description || '' })) });
    }
    const dense = await tryDenseSeeds(repoRoot, space, q, 50);
    const denseSet = new Map((dense || []).map(r => [r.id, r.score]));
    const ql = q.toLowerCase();
    const scored = pool.map(n => {
      const text = ((n.label || '') + ' ' + (n.description || '') + ' ' + (n.summary || '')).toLowerCase();
      let s = 0;
      for (const tok of ql.split(/\s+/)) if (tok && text.includes(tok)) s += 1;
      if (denseSet.has(n.id)) s += 2 * denseSet.get(n.id);
      return { id: n.id, label: n.label, file: n.sourceLocation?.file || null, description: n.description || '', score: s };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 30);
    return json(res, { q, name, results: scored });
  });

  // ── CLI coverage diagnostic ─────────────────────────────────────────────
  // Symphonee is a multi-CLI system - this endpoint shows per-CLI evidence
  // in the brain so the user can verify nothing's silently missing. For
  // each known CLI, returns: memory file presence (in active repo),
  // node count by tag, recent conversation count, history nodes, drawer
  // nodes. If a CLI has zero coverage that's a real signal something is
  // wrong (extractor bug, missing convention, etc), not a quirk.
  addRoute('GET', '/api/mind/cli-coverage', (req, res) => {
    const space = getSpace();
    const ui = getUiContext ? getUiContext() : {};
    const fs = require('fs');
    const path = require('path');
    const allRepos = (typeof ctx.getAllRepos === 'function' ? (ctx.getAllRepos() || {}) : {});
    const reposToCheck = Object.entries(allRepos).length ? Object.entries(allRepos) : [[ui.activeRepo || '_active', ui.activeRepoPath]];

    const KNOWN = ['claude', 'codex', 'gemini', 'grok', 'qwen', 'copilot', 'cursor', 'windsurf'];
    const { CLI_MEMORY_FILES } = require('./extractors/cli-memory');
    const memoryConventions = Object.fromEntries(CLI_MEMORY_FILES.map(e => [e.cli, e.paths]));

    const g = store.loadGraph(repoRoot, space);
    const nodes = (g && g.nodes) || [];
    const counts = {};
    for (const cli of KNOWN) counts[cli] = { memoryFiles: 0, conversations: 0, drawers: 0, history: 0, skills: 0, plugins: 0 };

    for (const n of nodes) {
      // memory nodes are id-prefixed climem_<cli>
      if (typeof n.id === 'string' && n.id.startsWith('climem_')) {
        const cli = n.id.replace('climem_', '');
        if (counts[cli]) counts[cli].memoryFiles += 1;
      }
      const cb = n.createdBy || '';
      if (n.kind === 'conversation' && KNOWN.includes(cb)) counts[cb].conversations += 1;
      if (n.kind === 'drawer' && KNOWN.includes(cb)) counts[cb].drawers += 1;
      if (n.source && n.source.type === 'cli-history' && KNOWN.includes(n.source.cli)) counts[n.source.cli].history += 1;
      // skills, agents, plugins are tagged via createdBy 'mind/cli-skills' but
      // each node has tags like cli:claude / cli:codex
      if (Array.isArray(n.tags)) {
        for (const t of n.tags) {
          for (const cli of KNOWN) {
            if (t === 'cli:' + cli || t === cli) {
              if (n.kind === 'plugin') counts[cli].plugins += 1;
              else if (n.kind === 'recipe' || n.kind === 'concept' || n.kind === 'doc') {
                if (Array.isArray(n.tags) && (n.tags.includes('skill') || n.tags.includes('agent'))) {
                  counts[cli].skills += 1;
                }
              }
            }
          }
        }
      }
    }

    // Per-repo memory file presence
    const memoryFilesByRepo = {};
    for (const [repoName, p] of reposToCheck) {
      if (!p) continue;
      memoryFilesByRepo[repoName] = {};
      for (const cli of KNOWN) {
        const candidates = memoryConventions[cli] || [];
        const found = candidates.find(rel => fs.existsSync(path.join(p, rel)));
        memoryFilesByRepo[repoName][cli] = found || null;
      }
    }

    return json(res, {
      space,
      cliKnown: KNOWN,
      counts,
      memoryConventions,
      memoryFilesByRepo,
      note: 'Symphonee is multi-CLI. Every supported CLI ingests symmetrically. A CLI with zero memory file in this repo simply means the file does not exist there, NOT that the CLI is unsupported.',
    });
  });

  // ── Quality (resolved-import ratio + unresolved examples) ────────────────
  // Surfaced even before Phase 1 ships ast-grep so the UI pill has something
  // to render. Returns { totalImportEdges, resolvedPct, unresolvedExamples }.
  addRoute('GET', '/api/mind/quality', (req, res) => {
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { space, totalImportEdges: 0, resolvedPct: null, unresolvedExamples: [] });
    let total = 0, resolved = 0;
    const unresolved = [];
    const nodeIds = new Set(g.nodes.map(n => n.id));
    for (const e of g.edges) {
      if (e.relation !== 'imports') continue;
      total += 1;
      const targetExists = nodeIds.has(e.target);
      const targetMarkedExternal = e.unresolved === true || (typeof e.target === 'string' && e.target.startsWith('ext_'));
      if (targetExists && !targetMarkedExternal) resolved += 1;
      else if (unresolved.length < 25) unresolved.push({ from: e.source, spec: e.target });
    }
    return json(res, {
      space,
      totalImportEdges: total,
      resolvedPct: total ? Math.round((resolved / total) * 1000) / 10 : null,
      resolvedCount: resolved,
      unresolvedExamples: unresolved,
      lastBuildAt: g.generatedAt,
    });
  });

  // ── Query (BFS sub-graph + suggested answer scaffold) ────────────────────
  addRoute('POST', '/api/mind/query', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty - run /api/mind/build first', empty: true }, 200);

    // If hybrid:false explicitly passed, skip dense entirely.
    let denseSeeds = null;
    if (body.hybrid !== false && body.question) {
      denseSeeds = await tryDenseSeeds(repoRoot, space, body.question, 50).catch(() => null);
    }

    const result = query.runQuery(g, {
      question: body.question || '',
      mode: body.mode || 'bfs',
      budget: body.budget || 2000,
      seedIds: body.seedIds || (denseSeeds && denseSeeds.length ? query.bestSeedsHybrid(g, body.question, 5, { dense: denseSeeds }) : null),
      asOf: body.asOf || null,
    });
    if (denseSeeds) result.denseSeedCount = denseSeeds.length;
    return json(res, result);
  });

  // Dense-only semantic search (debug + UI smart-search). Returns ranked nodes
  // by cosine similarity. The graph has to have been embedded first via
  // /api/mind/embed (or SYMPHONEE_EMBED_AUTO=1 during build).
  addRoute('POST', '/api/mind/search-semantic', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const q = body.q || body.query;
    if (!q) return json(res, { error: 'q required' }, 400);
    const k = Math.min(50, Math.max(1, body.k || 10));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const dense = await tryDenseSeeds(repoRoot, space, q, k);
    if (!dense) return json(res, { error: 'embeddings unavailable - run /api/mind/embed first', q, results: [] }, 200);
    const nodeMap = new Map(g.nodes.map(n => [n.id, n]));
    return json(res, {
      q,
      k,
      results: dense.map(r => ({
        id: r.id,
        score: r.score,
        node: nodeMap.get(r.id) || null,
      })),
    });
  });

  addRoute('POST', '/api/mind/embed', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    refreshEmbedKeys();
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const acq = lock.acquire(space, 'embed');
    if (!acq.ok) return json(res, { error: 'embedding already running', holderPid: acq.holderPid }, 409);

    // Build a provider chain: requested first, then the rest in priority order.
    const keys = (typeof getAiApiKeys === 'function' ? getAiApiKeys() : {}) || {};
    const candidates = [];
    if (body.provider) candidates.push(body.provider);
    if (keys.OPENAI_API_KEY && !candidates.includes('openai')) candidates.push('openai');
    if (keys.GOOGLE_API_KEY && !candidates.includes('google')) candidates.push('google');
    if (!candidates.length) {
      lock.release(space, 'embed');
      return json(res, {
        error: 'No embedding provider configured. Add an OpenAI or Google API key in Settings > AI Providers.',
      }, 400);
    }

    json(res, { ok: true, started: true, providerChain: candidates });
    let lastErr = null;
    for (const provider of candidates) {
      try {
        const r = await engine.refreshEmbeddings({
          repoRoot, space, graph: g,
          ctx: { embedProvider: provider },
          onProgress: (msg) => {
            if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-progress', msg, provider } });
          },
        });
        if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-complete', result: { ...r, provider } } });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err.message || String(err);
        const isProviderError = /api[_ ]?key|credit|quota|insufficient|RESOURCE_EXHAUSTED|401|402|403|429|unavailable|ECONNREFUSED|fetch failed/i.test(msg);
        if (!isProviderError || candidates.indexOf(provider) === candidates.length - 1) {
          // Either not a failover-able error, or we're out of candidates.
          break;
        }
        // Try next provider; broadcast a notice so the UI can toast.
        if (broadcast) broadcast({
          type: 'orchestrator-event',
          event: 'provider-failover',
          from: provider,
          reason: 'embedding ' + (msg.match(/credit|quota/i) ? 'out of credits' : 'failed'),
          errorSnippet: msg.slice(0, 160),
        });
      }
    }
    if (lastErr) {
      const msg = lastErr.message || String(lastErr);
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-failed', error: msg } });
      if (broadcast) broadcast({
        type: 'orchestrator-event',
        event: 'provider-exhausted',
        lastCli: candidates[candidates.length - 1],
        reason: 'embedding failed after trying ' + candidates.length + ' provider(s)',
      });
    }
    lock.release(space, 'embed');
  });

  // ── Health (embeddings + vectors store status) ───────────────────────────
  addRoute('GET', '/api/mind/health', async (req, res) => {
    const space = getSpace();
    const vs = new VectorStore(repoRoot, space);
    vs.load();
    const url = new URL(req.url, 'http://x');
    refreshEmbedKeys();
    const provider = url.searchParams.get('provider') || embeddings.pickProvider();
    const fresh = url.searchParams.get('fresh') === '1';
    const h = provider
      ? await embeddings.health({ provider, fresh })
      : await embeddings.health({ fresh });
    return json(res, {
      space,
      embeddings: h,
      vectors: {
        count: vs.count(),
        dim: vs.dim,
        provider: vs.provider,
        model: vs.model,
        ok: vs.count() > 0,
      },
    });
  });

  // ── Q&A feedback loop: save an answer back into the graph ────────────────
  //
  // Cite-grounding check: every cited node ID must (a) actually exist in the
  // graph, and (b) have its label or a substring of its content referenced
  // somewhere in the answer text. Otherwise the brain would happily store
  // plausible-sounding but ungrounded text — the failure mode that erodes
  // trust in RAG systems over time.
  //
  // The check is *advisory by default* — confidence on ungrounded edges
  // downgrades to AMBIGUOUS rather than rejecting the save outright.
  // Pass `strict: true` to reject saves with no grounded citations at all.
  addRoute('POST', '/api/mind/save-result', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const { question, answer, citedNodeIds = [], createdBy = 'unknown', strict = false } = body;
    if (!question || !answer) return json(res, { error: 'question and answer required' }, 400);
    const space = getSpace();
    let g = store.loadGraph(repoRoot, space) || store.emptyGraph({ space });

    // Audit each citation: does the answer actually reference the node?
    const lowerAnswer = String(answer).toLowerCase();
    const audit = [];
    for (const cited of citedNodeIds) {
      const node = g.nodes.find(n => n.id === cited);
      if (!node) { audit.push({ id: cited, status: 'unknown' }); continue; }
      const labelHit = node.label && lowerAnswer.includes(String(node.label).toLowerCase().slice(0, 60));
      const idHit = lowerAnswer.includes(String(cited).toLowerCase());
      audit.push({ id: cited, status: (labelHit || idHit) ? 'grounded' : 'ungrounded' });
    }
    const grounded = audit.filter(a => a.status === 'grounded');
    if (strict && citedNodeIds.length > 0 && grounded.length === 0) {
      return json(res, {
        error: 'no cited nodes are grounded in the answer text',
        audit,
        hint: 'reference each cited node by its label or id in your answer, or set strict:false to save anyway',
      }, 400);
    }

    const ts = Date.now();
    const id = `qa_${ts}_${Math.random().toString(36).slice(2, 6)}`;
    g.nodes.push({
      id, label: sanitizeLabel(question.slice(0, 120)), kind: 'conversation',
      source: { type: 'qa', ref: createdBy }, sourceLocation: null,
      createdBy, createdAt: new Date().toISOString(), tags: ['qa'],
      answer: sanitizeLabel(answer.slice(0, 4000)),
      groundedCount: grounded.length,
      citationCount: citedNodeIds.length,
    });
    for (const cited of citedNodeIds) {
      const node = g.nodes.find(n => n.id === cited);
      if (!node) continue;
      const a = audit.find(x => x.id === cited);
      // Ungrounded citations get edge confidence INFERRED + a lower score,
      // so query consumers see the warning without the data being lost.
      const isGrounded = a && a.status === 'grounded';
      g.edges.push({
        source: id, target: cited, relation: 'derived_from',
        confidence: isGrounded ? 'EXTRACTED' : 'INFERRED',
        confidenceScore: isGrounded ? 1.0 : 0.5,
        weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }
    persistDerivedGraph(space, g);
    if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'node-added', id, createdBy } });
    notifyKnowledgeEvent({ kind: 'save-result', nodeIds: [id], reason: 'qa-saved' });

    // Auto-extract memory cards from the answer text. Conservative
    // patterns ("remember:", "we decided", "the rule is", "prefer X",
    // "watch out for", ...) become first-class kind:memory nodes linked
    // back to this conversation node. Idempotent via content-hash so
    // re-saving the same answer doesn't duplicate cards.
    const memoryModule = require('./memory');
    const candidates = memoryModule.extractMemoriesFromText(answer);
    const memoriesCreated = [];
    if (candidates.length) {
      // Reload the graph so we see the conversation node we just wrote.
      const reloaded = store.loadGraph(repoRoot, space) || g;
      const existingMemoryHashes = new Set();
      for (const n of reloaded.nodes) {
        if (n.kind === 'memory' && typeof n.body === 'string') {
          existingMemoryHashes.add(n.body.toLowerCase().trim().slice(0, 240));
        }
      }
      // Carry forward brand tags from cited entity nodes so a memory
      // about "DYOB design" auto-tags DYOB even if the answer text
      // didn't list it.
      const carryTags = [];
      for (const cited of citedNodeIds) {
        const node = reloaded.nodes.find(n => n.id === cited);
        if (!node) continue;
        if (node.kind === 'entity' && typeof node.label === 'string') carryTags.push(node.label);
      }
      for (const cand of candidates) {
        const hash = cand.body.toLowerCase().trim().slice(0, 240);
        if (existingMemoryHashes.has(hash)) continue;
        existingMemoryHashes.add(hash);
        try {
          const r = await memoryModule.addMemoryCard({
            repoRoot, space,
            spec: {
              ...cand,
              tags: carryTags,
              source: { type: 'conversation', ref: id },
              createdBy: createdBy || 'mind/auto-extract',
            },
          });
          memoriesCreated.push({ id: r.node.id, title: r.node.label, kindOfMemory: r.node.kindOfMemory });
        } catch (_) { /* one bad pattern must not break the save */ }
      }
      if (memoriesCreated.length && broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'memory-extracted', conversationId: id, count: memoriesCreated.length, memories: memoriesCreated } });
      }
      if (memoriesCreated.length) {
        notifyKnowledgeEvent({ kind: 'memory-auto-extracted', nodeIds: memoriesCreated.map(m => m.id), reason: 'auto-memory' });
      }
    }

    return json(res, { ok: true, nodeId: id, audit, groundedCount: grounded.length, memoriesCreated });
  });

  // ── Recall: time-ranged + topic-filtered retrieval ─────────────────────
  // Different from /api/mind/query (BFS sub-graph) - returns a ranked
  // LIST of recall-eligible items (memories, conversations, drawers)
  // restricted to a time window and optionally a repo. Answers "what
  // did I figure out about X 10 days ago?" / "what do I know about
  // Playdate?" without graph traversal.
  //
  // POST /api/mind/recall
  //   {
  //     "question": "DYOB design",          // optional, BM25 ranks
  //     "since":    "10 days ago",          // ISO or natural string
  //     "until":    "today",                // ISO or natural string
  //     "repo":     "DYOB3",                // optional repo scope
  //     "kinds":    ["memory","conversation"], // default all
  //     "limit":    20
  //   }
  // Returns { hits, total, since, until, repo, question }
  addRoute('POST', '/api/mind/recall', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body || typeof body !== 'object') {
      return json(res, { error: 'request body must be a JSON object' }, 400);
    }
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { hits: [], total: 0, message: 'no graph for this space' });
    const recallModule = require('./recall');
    try {
      const result = recallModule.recall(g, {
        question: body.question || '',
        since:    body.since,
        until:    body.until,
        repo:     body.repo,
        kinds:    body.kinds,
        limit:    body.limit,
      });
      return json(res, result);
    } catch (e) {
      return json(res, { error: e.message }, 400);
    }
  });

  // ── Memory cards: durable knowledge taught mid-conversation ─────────────
  // The user (or an AI on their behalf) committed a fact. "DYOB doesn't
  // follow the Bath Fitter design system." "For Playdate, prefer pulldown
  // for menu navigation." "Don't mock the database in tests - we got
  // burned last quarter." Each becomes a kind:memory node, indexed by
  // tags, linked to its source conversation if known, and surfaceable on
  // wakeup + recall queries.
  //
  // POST /api/mind/teach
  //   {
  //     "title":          "DYOB doesn't follow Bath Fitter brand",
  //     "body":           "Different colour palette + typography ...",
  //     "kindOfMemory":   "constraint" | "decision" | "preference" |
  //                       "lesson" | "gotcha" | "pattern" | "fact",
  //     "tags":           ["DYOB", "Bath Fitter", "design"],
  //     "scope":          { "repo": "DYOB3" },          // optional
  //     "source":         { "type": "conversation",     // optional
  //                         "ref":  "<existing node id>" },
  //     "createdBy":      "claude" | "codex" | "user" | ...
  //   }
  // Returns: { ok, nodeId, node, edges }
  addRoute('POST', '/api/mind/teach', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body || typeof body !== 'object') {
      return json(res, { error: 'request body must be a JSON object' }, 400);
    }
    const space = getSpace();
    const memoryModule = require('./memory');
    try {
      const { node, edges } = await memoryModule.addMemoryCard({
        repoRoot, space, spec: body,
      });
      if (broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'memory-added', id: node.id, title: node.label, createdBy: node.createdBy } });
      }
      notifyKnowledgeEvent({ kind: 'teach', nodeIds: [node.id], reason: 'memory-card-taught' });
      return json(res, { ok: true, nodeId: node.id, node, edges });
    } catch (e) {
      if (e.code === 'MIND_LOCKED') {
        return json(res, { error: e.message, holderPid: e.holderPid }, 409);
      }
      return json(res, { error: e.message }, 400);
    }
  });

  // ── Manual ingest: a user/agent pushes one artefact at a time ────────────
  addRoute('POST', '/api/mind/add', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (body.url) { try { validateUrl(body.url); } catch (e) { return json(res, { error: e.message }, 400); } }
    const space = getSpace();
    let g = store.loadGraph(repoRoot, space) || store.emptyGraph({ space });
    const ts = Date.now();
    const id = `manual_${ts}_${Math.random().toString(36).slice(2, 6)}`;
    g.nodes.push({
      id, label: sanitizeLabel(body.label || body.url || body.path || 'untitled'),
      kind: body.kind || 'concept',
      source: { type: 'manual', ref: body.url || body.path || null },
      createdBy: body.createdBy || 'manual', createdAt: new Date().toISOString(),
      tags: Array.isArray(body.tags) ? body.tags : [],
    });
    persistDerivedGraph(space, g);
    notifyKnowledgeEvent({ kind: 'manual-ingest', nodeIds: [id], reason: 'manual-add' });
    return json(res, { ok: true, nodeId: id });
  });

  // ── Watch mode ───────────────────────────────────────────────────────────
  let watcher = null;
  // Watch always re-ingests every Symphonee-managed repo on each tick. Mind
  // is meant to span all connected projects.
  const triggerIncrementalUpdate = async (trigger) => {
    const space = getSpace();
    const jobId = makeJobId();
    // trigger can be an array of changed file paths (file watcher) OR an
    // object { knowledgeEvent, reasons, nodeIds } (notifyKnowledgeEvent).
    const triggerSummary = Array.isArray(trigger) ? { changedFiles: trigger } : (trigger || {});
    const job = { id: jobId, kind: triggerSummary.knowledgeEvent ? 'knowledge-update' : 'watch-update', space, status: 'running', startedAt: Date.now(), progress: [], trigger: triggerSummary };
    jobs.set(jobId, job);
    try {
      const result = await engine.runBuild({
        repoRoot, space,
        sources: DEFAULT_BUILD_SOURCES,
        incremental: true, ctx,
        onProgress: (msg) => job.progress.push({ ts: Date.now(), msg }),
      });
      job.status = 'completed'; job.completedAt = Date.now(); job.result = result;
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'update-complete', jobId, result, trigger: 'watch' } });
    } catch (err) {
      job.status = 'failed'; job.completedAt = Date.now(); job.error = err.message;
    }
  };

  function startWatcher(debounceMs) {
    if (watcher) watcher.stop();
    watcher = new MindWatcher({
      repoRoot, getUiContext: ctx.getUiContext, broadcast,
      debounceMs: typeof debounceMs === 'number' ? debounceMs : 3000,
      onTrigger: triggerIncrementalUpdate,
    });
    watcher.start();
    persistWatchPreference(true);
  }
  function stopWatcher() {
    if (watcher) { watcher.stop(); watcher = null; }
    persistWatchPreference(false);
  }
  function persistWatchPreference(enabled) {
    try {
      const file = path.join(repoRoot, '.symphonee', 'mind', 'watch.json');
      require('fs').mkdirSync(path.dirname(file), { recursive: true });
      require('fs').writeFileSync(file, JSON.stringify({ enabled, savedAt: Date.now() }), 'utf8');
    } catch (_) { /* best-effort */ }
  }
  function readWatchPreference() {
    try {
      const file = path.join(repoRoot, '.symphonee', 'mind', 'watch.json');
      if (!require('fs').existsSync(file)) return null;
      return JSON.parse(require('fs').readFileSync(file, 'utf8'));
    } catch (_) { return null; }
  }

  addRoute('POST', '/api/mind/watch', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const enabled = body.enabled !== false;
    if (!enabled) { stopWatcher(); return json(res, { enabled: false }); }
    startWatcher(body.debounceMs);
    return json(res, { enabled: true, debounceMs: watcher.debounceMs });
  });

  // Watcher is ON by default. Mind is meant to feel continuously alive —
  // every edit, every learning, every conversation should land without
  // anyone having to remember to rebuild. The only way it stays off is if
  // the user explicitly disabled it (watch.json says enabled:false).
  // Defer one tick so the rest of the server (routes, broadcast) is wired.
  setImmediate(() => {
    try {
      const saved = readWatchPreference();
      if (saved && saved.enabled === false) return; // explicit opt-out
      startWatcher();
    } catch (_) { /* best-effort; default-on still applies */ }
  });

  // ── Reflection (dream pass) ──────────────────────────────────────────────
  // Manual trigger: POST /api/mind/reflect { windowHours?, dryRun? }
  addRoute('POST', '/api/mind/reflect', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    try {
      const result = await reflectOnce({
        repoRoot, space,
        windowHours: typeof body.windowHours === 'number' ? body.windowHours : 24,
        dryRun: body.dryRun === true,
      });
      if (result.cardsCreated > 0 && broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'reflection-promoted', count: result.cardsCreated, cards: result.cards } });
      }
      return json(res, result);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  });

  // ── Embedding setup (Smart Search) ───────────────────────────────────────
  //
  // /api/mind/embed-status returns what the UI's Settings panel needs to
  // render its current state: which provider is active, whether Ollama is
  // installed/running/has the model, vector count.
  addRoute('GET', '/api/mind/embed-status', async (req, res) => {
    refreshEmbedKeys();
    const space = getSpace();
    let vectorCount = 0, vectorDim = 0;
    try {
      const vs = new VectorStore(repoRoot, space);
      vs.load();
      vectorCount = vs.count();
      vectorDim = vs.dim;
    } catch (_) {}
    // Live probe of Ollama (forced — bypasses the 5min cache so the UI
    // always sees current state when the user opens Settings).
    try { await embeddings.refreshOllamaStatus({ force: true }); } catch (_) {}
    try { await llm.refreshChatStatus({ force: true }); } catch (_) {}
    const detect = await ollamaSetup.detect({
      model: embeddings.OLLAMA_DEFAULT_MODEL,
      chatModel: ollamaSetup.DEFAULT_CHAT_MODEL,
    });
    const provider = embeddings.pickProvider();
    return json(res, {
      activeProvider: provider || 'bm25',   // ollama | bm25 (cloud never picked)
      ollama: {
        installed: detect.installed,
        installPath: detect.installPath,
        running: detect.running,
        modelInstalled: detect.modelInstalled,
        model: detect.model,
        models: detect.models,
      },
      chat: {
        modelInstalled: detect.chatModelInstalled,
        preferredModel: detect.preferredChat,
        defaultModel: detect.chatModel,
        installedChatModels: detect.chatModels,
      },
      vectors: { count: vectorCount, dim: vectorDim },
      downloadUrl: 'https://ollama.com/download',
    });
  });

  // Shared setup pipeline used by both the auto-bootstrap and the manual
  // /api/mind/embed-setup route. Idempotent. Returns a result describing
  // the final state. Every progress beat fires as a `mind-update` event
  // with kind:'embed-setup' so any subscribed UI can render it.
  let _embedSetupRunning = false;
  async function runEmbedSetup({ model, source = 'manual' } = {}) {
    if (_embedSetupRunning) return { ok: false, reason: 'already-running' };
    _embedSetupRunning = true;
    const m = model || embeddings.OLLAMA_DEFAULT_MODEL;
    const space = getSpace();
    const step = (kind, payload = {}) => {
      if (!broadcast) return;
      broadcast({ type: 'mind-update', payload: { kind: 'embed-setup', step: kind, source, ...payload } });
    };
    try {
      step('detect', {});
      let detect = await ollamaSetup.detect({ model: m });
      if (!detect.installed) {
        step('needs-install', { downloadUrl: 'https://ollama.com/download' });
        return { ok: false, reason: 'needs-install' };
      }
      if (!detect.running) {
        step('launching', { installPath: detect.installPath });
        const launch = await ollamaSetup.ensureRunning({ installPath: detect.installPath });
        if (!launch.ok) { step('launch-failed', launch); return { ok: false, reason: 'launch-failed' }; }
        detect = await ollamaSetup.detect({ model: m });
      }
      if (!detect.modelInstalled) {
        step('pulling-model', { model: m });
        const pull = await ollamaSetup.ensureModel({ model: m, broadcast });
        if (!pull.ok) { step('pull-failed', pull); return { ok: false, reason: 'pull-failed' }; }
      }
      // Vector store is provider-specific (OpenAI=1536, Ollama=768).
      // Switching providers means dropping the old store before the
      // rebuild — engine.refreshEmbeddings expects an empty store when
      // initialising with a new provider.
      step('dropping-old-vectors', {});
      try {
        const vs = new VectorStore(repoRoot, space);
        if (vs.load() && vs.provider !== 'ollama') vs.drop();
      } catch (_) { /* nothing to drop */ }
      await embeddings.refreshOllamaStatus({ force: true });
      step('rebuilding-vectors', { provider: 'ollama' });
      const g = store.loadGraph(repoRoot, space);
      if (!g) { step('done', { reason: 'no-graph', vectorCount: 0 }); return { ok: true, vectorCount: 0 }; }
      try {
        await engine.refreshEmbeddings({
          repoRoot, space, graph: g,
          ctx: { embedProvider: 'ollama' },
          onProgress: (msg) => step('embed-progress', { msg }),
        });
      } catch (e) {
        step('embed-failed', { error: e.message });
        return { ok: false, reason: 'embed-failed', error: e.message };
      }
      step('done', { provider: 'ollama' });
      return { ok: true, provider: 'ollama' };
    } catch (e) {
      step('error', { error: e.message });
      return { ok: false, reason: 'error', error: e.message };
    } finally {
      _embedSetupRunning = false;
    }
  }

  // /api/mind/embed-setup is now a thin wrapper over runEmbedSetup so
  // the user can still trigger it explicitly (recovery / diagnostics).
  // The same pipeline runs automatically on boot — see autoBootstrap below.
  addRoute('POST', '/api/mind/embed-setup', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    json(res, { ok: true, started: true, model: body.model || embeddings.OLLAMA_DEFAULT_MODEL });
    runEmbedSetup({ model: body.model, source: 'manual' }).catch(() => {});
  });

  // Auto-bootstrap: every boot, Mind tries to make local embeddings work
  // without anyone clicking anything. Silent unless something needs the
  // user — and even then it's a passive UI hint, not a modal.
  //
  // States:
  //   - Ollama installed + running + model pulled + vectors match    -> nothing to do
  //   - Ollama installed but not running                              -> launch
  //   - Ollama running but model missing                              -> pull
  //   - Vector store has wrong provider/dim                           -> drop + rebuild
  //   - Ollama not installed                                          -> emit `needs-install` hint, exit
  //
  // After the initial bootstrap, the heal watchdog (every 5min) keeps
  // filling in vectors for new nodes — no further intervention needed.
  async function autoBootstrapEmbeddings() {
    try {
      const space = getSpace();
      const m = embeddings.OLLAMA_DEFAULT_MODEL;
      const chatM = ollamaSetup.DEFAULT_CHAT_MODEL;
      const detect = await ollamaSetup.detect({ model: m, chatModel: chatM });
      if (!detect.installed) {
        if (broadcast) broadcast({
          type: 'mind-update',
          payload: { kind: 'embed-setup', step: 'needs-install', source: 'auto', downloadUrl: 'https://ollama.com/download' },
        });
        return;
      }
      // Embedding side: rebuild only when there's nothing usable yet OR
      // the store belongs to a different provider. Heal watchdog handles
      // ongoing backfill, so we don't touch the store when it's healthy.
      let needsRebuild = false;
      try {
        const vs = new VectorStore(repoRoot, space);
        if (!vs.load() || vs.count() === 0 || vs.provider !== 'ollama') needsRebuild = true;
      } catch (_) { needsRebuild = true; }
      if (!detect.running || !detect.modelInstalled || needsRebuild) {
        await runEmbedSetup({ model: m, source: 'auto' });
      } else {
        await embeddings.refreshOllamaStatus({ force: true });
      }
      // Chat-model side: silently pull the reflection model if no chat
      // model is installed yet. This is the "humanless" pull — the user
      // never has to know it happened. ensureRunning was already handled
      // above so we know Ollama is alive at this point.
      const postEmbedDetect = await ollamaSetup.detect({ model: m, chatModel: chatM });
      if (postEmbedDetect.running && !postEmbedDetect.chatModelInstalled) {
        if (broadcast) broadcast({
          type: 'mind-update',
          payload: { kind: 'embed-setup', step: 'pulling-chat-model', source: 'auto', model: chatM },
        });
        const pull = await ollamaSetup.ensureModel({ model: chatM, broadcast });
        if (pull.ok) {
          if (broadcast) broadcast({
            type: 'mind-update',
            payload: { kind: 'embed-setup', step: 'chat-model-ready', source: 'auto', model: chatM },
          });
          await llm.refreshChatStatus({ force: true });
        }
      } else if (postEmbedDetect.chatModelInstalled) {
        await llm.refreshChatStatus({ force: true });
      }
    } catch (e) {
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-setup', step: 'error', source: 'auto', error: e.message } });
    }
  }
  // Run shortly after boot so other subsystems (broadcast, watcher,
  // schedulers) are wired before any progress events start firing.
  if (!ctx._autoBootstrapStarted) {
    ctx._autoBootstrapStarted = true;
    setTimeout(() => { autoBootstrapEmbeddings().catch(() => {}); }, 3_500);
    // Retry every 30 min in case Ollama becomes available later (e.g.
    // user installed it without restarting Symphonee).
    setInterval(() => { autoBootstrapEmbeddings().catch(() => {}); }, 30 * 60 * 1000).unref();
  }

  // ── Self-healing watchdog ────────────────────────────────────────────────
  // Manual trigger: POST /api/mind/heal { skipEmbed?, maxNodes? }
  addRoute('POST', '/api/mind/heal', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    try {
      const result = await healOnce({
        repoRoot, space, getAiApiKeys,
        opts: { skipEmbed: body.skipEmbed === true, maxNodes: body.maxNodes },
      });
      if (result.healed > 0 && broadcast) {
        broadcast({ type: 'mind-update', payload: { kind: 'self-healed', healed: result.healed, findings: result.findings } });
      }
      return json(res, result);
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  });

  // ── Proactive insights ────────────────────────────────────────────────
  //
  // Insights run all four analysers, dedupe via signature, persist as
  // kind:insight graph nodes. The scheduler fires hourly (or on the
  // continuous-learning cadence) and also after save-result for fast
  // signals like repeated-question.

  async function generateInsights({ source = 'manual', categories } = {}) {
    const space = getSpace();
    const ui = getUiContext ? getUiContext() : {};
    const enabled = !categories || categories.length === 0
      ? ['repeated-question', 'co-edit', 'memory-decay', 'cross-repo']
      : categories;
    const candidates = [];
    if (enabled.includes('repeated-question')) {
      try { candidates.push(...await repeatedQuestionAnalyser.detect({ repoRoot, space })); } catch (e) { console.warn('[insights/A]', e.message); }
    }
    if (enabled.includes('co-edit')) {
      try { candidates.push(...await coEditAnalyser.detect({ getUiContext })); } catch (e) { console.warn('[insights/B]', e.message); }
    }
    if (enabled.includes('memory-decay')) {
      try { candidates.push(...memoryDecayAnalyser.detect({ repoRoot, space })); } catch (e) { console.warn('[insights/C]', e.message); }
    }
    if (enabled.includes('cross-repo')) {
      try { candidates.push(...await crossRepoAnalyser.detect({ repoRoot, space })); } catch (e) { console.warn('[insights/D]', e.message); }
    }
    const added = [];
    for (const spec of candidates) {
      try {
        const r = await insights.addInsight({ repoRoot, space, spec });
        if (!r.deduped) added.push(r.node);
      } catch (e) { console.warn('[insights/add]', e.message); }
    }
    if (added.length && broadcast) {
      broadcast({ type: 'mind-update', payload: { kind: 'insights-generated', source, count: added.length, ids: added.map(n => n.id) } });
    }
    return { ok: true, generated: added.length, candidates: candidates.length, source };
  }

  // GET /api/mind/insights?status=pending|acted|dismissed|snoozed|all
  addRoute('GET', '/api/mind/insights', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const status = url.searchParams.get('status') || 'pending';
    const space = getSpace();
    const items = insights.listInsights({ repoRoot, space, status });
    return json(res, { items, count: items.length, status });
  });

  // GET /api/mind/suggestions?topic=<text>&limit=<n>
  // The "is there anything we can do?" surface. Returns pending insights
  // ranked by relevance to the topic (BM25 against title + body). If no
  // topic is given, returns all pending insights sorted by recency. CLIs
  // call this when the user asks for suggestions.
  addRoute('GET', '/api/mind/suggestions', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const topic = (url.searchParams.get('topic') || '').trim();
    const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
    const space = getSpace();
    let items = insights.listInsights({ repoRoot, space, status: 'pending' });
    if (topic) {
      // Cheap BM25-style scoring without pulling in the full index.
      // Each insight scores by how many topic terms appear in its
      // searchable text (label + body + category + payload labels).
      const terms = topic.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length >= 3);
      items = items.map(it => {
        const blob = [
          it.label, it.body, it.category,
          it.action && it.action.payload && it.action.payload.title,
          it.action && it.action.payload && it.action.payload.description,
          ...(Array.isArray(it.action && it.action.payload && it.action.payload.tags) ? it.action.payload.tags : []),
        ].filter(Boolean).join(' ').toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (blob.indexOf(t) !== -1) score += 1;
        }
        return { ...it, _topicScore: score };
      }).filter(it => it._topicScore > 0).sort((a, b) => b._topicScore - a._topicScore);
    }
    return json(res, { items: items.slice(0, limit), count: Math.min(items.length, limit), topic: topic || null });
  });

  // POST /api/mind/insights/generate { categories?: ['repeated-question',...] }
  addRoute('POST', '/api/mind/insights/generate', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    json(res, { ok: true, started: true });
    generateInsights({ source: 'manual', categories: body.categories }).catch(() => {});
  });

  // POST /api/mind/insights/act { id }
  // Executes the insight's action payload against the appropriate mind
  // endpoint and marks the insight as acted on success.
  addRoute('POST', '/api/mind/insights/act', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    const items = insights.listInsights({ repoRoot, space, status: 'all' });
    const target = items.find(n => n.id === body.id);
    if (!target) return json(res, { error: 'insight not found' }, 404);
    let actionResult = null;
    try {
      switch (target.action.type) {
        case 'create-memory': {
          const r = await memoryModule.addMemoryCard({ repoRoot, space, spec: target.action.payload });
          actionResult = { kind: 'memory', id: r.node.id };
          notifyKnowledgeEvent({ kind: 'insight-acted-memory', nodeIds: [r.node.id], reason: 'insight-act' });
          break;
        }
        case 'create-recipe': {
          // Write a recipe stub to recipes/<slug>.json so the existing
          // recipe surfaces pick it up. The user can flesh out steps
          // later; we just save the files-to-edit hint.
          const fs = require('fs');
          const slug = (target.action.payload.slug || 'recipe').replace(/[^a-z0-9_-]/g, '-');
          const recipesDir = path.join(repoRoot, 'recipes');
          try { fs.mkdirSync(recipesDir, { recursive: true }); } catch (_) {}
          const recipePath = path.join(recipesDir, slug + '.json');
          const recipe = {
            slug,
            title: target.action.payload.title || slug,
            description: target.action.payload.description || '',
            files: target.action.payload.files || [],
            source: 'mind/insights',
            createdAt: new Date().toISOString(),
          };
          fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
          actionResult = { kind: 'recipe', path: recipePath, slug };
          break;
        }
        case 'archive-memories': {
          const ids = Array.isArray(target.action.payload.ids) ? target.action.payload.ids : [];
          const acq = lock.acquire(space, 'graph');
          if (!acq.ok) return json(res, { error: 'mind busy' }, 409);
          let archived = 0;
          try {
            const g = store.loadGraph(repoRoot, space);
            if (g) {
              for (const id of ids) {
                const idx = g.nodes.findIndex(n => n.id === id && n.kind === 'memory');
                if (idx === -1) continue;
                g.nodes[idx] = { ...g.nodes[idx], status: 'archived', archivedAt: new Date().toISOString() };
                archived++;
              }
              store.saveGraph(repoRoot, space, g);
            }
          } finally { lock.release(space, 'graph'); }
          actionResult = { kind: 'archive', archivedCount: archived };
          break;
        }
        case 'extract-shared': {
          // Persist a note describing the suggestion; the user works
          // through extraction at their own pace.
          const fs = require('fs');
          const notesDir = path.join(repoRoot, 'notes', getSpace());
          try { fs.mkdirSync(notesDir, { recursive: true }); } catch (_) {}
          const ts = Date.now();
          const fname = `extract-shared-${ts}.md`;
          const noteBody = [
            `# ${target.action.payload.noteTitle || 'Extract shared'}`,
            '',
            target.action.payload.noteBody || '',
            '',
            'Repos:',
            ...(target.action.payload.repos || []).map(r => `  - ${r}`),
          ].join('\n');
          fs.writeFileSync(path.join(notesDir, fname), noteBody);
          actionResult = { kind: 'note', file: fname };
          break;
        }
        default:
          return json(res, { error: 'unknown action type: ' + target.action.type }, 400);
      }
      const updated = await insights.markActed({ repoRoot, space, id: body.id, result: actionResult });
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'insight-acted', id: body.id, actionResult } });
      return json(res, { ok: true, insight: updated, actionResult });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  });

  addRoute('POST', '/api/mind/insights/dismiss', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    try {
      const updated = await insights.dismissInsight({ repoRoot, space, id: body.id });
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'insight-dismissed', id: body.id } });
      return json(res, { ok: true, insight: updated });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, e.code === 'MIND_LOCKED' ? 409 : 500);
    }
  });

  addRoute('POST', '/api/mind/insights/snooze', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    try {
      const updated = await insights.snoozeInsight({ repoRoot, space, id: body.id, durationMs: body.durationMs });
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'insight-snoozed', id: body.id, snoozedUntil: updated.snoozedUntil } });
      return json(res, { ok: true, insight: updated });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, e.code === 'MIND_LOCKED' ? 409 : 500);
    }
  });

  // Hourly scheduler. Reuses the same idle/continuous cadence the
  // reflection cycle uses so users only have to think about one knob.
  function startInsightsScheduler() {
    const TICK_MS = 60 * 1000;
    const HOURLY_MS = 60 * 60 * 1000;
    const CONTINUOUS_MS = 15 * 60 * 1000; // less aggressive than reflection
    let lastRun = 0;
    let running = false;
    const tick = async () => {
      if (running) return;
      let cfg = {};
      try { cfg = getConfig ? getConfig() : {}; } catch (_) {}
      const continuous = cfg.EnableContinuousLearning === true;
      const since = Date.now() - lastRun;
      if (!(since >= (continuous ? CONTINUOUS_MS : HOURLY_MS))) return;
      running = true;
      try {
        await generateInsights({ source: continuous ? 'continuous' : 'hourly' });
        lastRun = Date.now();
      } catch (e) {
        console.warn('[insights/scheduler]', e.message);
      } finally { running = false; }
    };
    const timer = setInterval(tick, TICK_MS);
    const boot = setTimeout(() => { tick().catch(() => {}); }, 45_000);
    return () => { clearInterval(timer); clearTimeout(boot); };
  }

  // Start the background reflection + healing + insights loops. All
  // are cheap when nothing's wrong (a few filesystem stats per tick);
  // expensive only when there's actual work. Idempotent if mountMind
  // is called twice (would never happen in production but keeps tests
  // sane).
  if (!ctx._schedulersStarted) {
    ctx._schedulersStarted = true;
    startReflectionScheduler({ repoRoot, getSpace, getConfig, getLastEventAt, broadcast });
    startHealingScheduler({ repoRoot, getSpace, getAiApiKeys, broadcast });
    startInsightsScheduler();
  }

  addRoute('GET', '/api/mind/watch', (req, res) => {
    return json(res, { enabled: !!(watcher && watcher._enabled) });
  });

  // ── Layout cache (per space + mode) ──────────────────────────────────────
  // The 3D / 2D force-graph simulation pins Intel iGPUs at 80%+ CPU/GPU on
  // every load when there are thousands of nodes. We solve it by computing
  // the layout ONCE and persisting (x, y, z) per node id. Subsequent loads
  // place nodes at the cached positions and skip physics entirely. The
  // cache is invalidated when the node set changes (different ids → re-layout).
  //
  // Storage: <repoRoot>/.symphonee/mind/spaces/<space>/layout-<mode>.json
  // Shape: { computedAt, nodeCount, nodeHash, positions: {nodeId: [x,y,z]} }
  const layoutPath = (space, mode) => path.join(repoRoot, '.symphonee', 'mind', 'spaces', space, `layout-${(mode || '3d').replace(/[^a-z0-9_-]/gi, '')}.json`);

  addRoute('GET', '/api/mind/layout', (req, res) => {
    const space = getSpace();
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('mode') || '3d';
    const p = layoutPath(space, mode);
    if (!fs.existsSync(p)) return json(res, { cached: false });
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return json(res, { cached: true, ...data });
    } catch (e) {
      return json(res, { cached: false, error: e.message });
    }
  });

  addRoute('POST', '/api/mind/layout', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.positions || typeof body.positions !== 'object') {
      return json(res, { error: 'positions object required' }, 400);
    }
    const space = getSpace();
    const mode = body.mode || '3d';
    const p = layoutPath(space, mode);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const payload = {
        computedAt: new Date().toISOString(),
        nodeCount: Object.keys(body.positions).length,
        nodeHash: body.nodeHash || null,
        mode,
        positions: body.positions,
      };
      fs.writeFileSync(p, JSON.stringify(payload));
      return json(res, { ok: true, cachedAt: payload.computedAt, nodeCount: payload.nodeCount });
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  });

  addRoute('DELETE', '/api/mind/layout', (req, res) => {
    const space = getSpace();
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('mode') || '3d';
    const p = layoutPath(space, mode);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return json(res, { ok: true });
    } catch (e) { return json(res, { error: e.message }, 500); }
  });

  // ── Delete (purge a hallucinated node) ───────────────────────────────────
  addRoute('DELETE', '/api/mind/node', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const id = body.id;
    if (!id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'no graph' }, 404);
    const before = g.nodes.length;
    g.nodes = g.nodes.filter(n => n.id !== id);
    g.edges = g.edges.filter(e => e.source !== id && e.target !== id);
    if (g.nodes.length === before) return json(res, { error: 'not found' }, 404);
    persistDerivedGraph(space, g);
    return json(res, { ok: true, removed: id });
  });

  return {
    // For the bootstrap composer
    bootstrapField() {
      const space = getSpace();
      const stats = store.statsFor(repoRoot, space);
      const ui = getUiContext ? getUiContext() : {};
      // L0+L1 wake-up text bundled with the bootstrap so every CLI gets the
      // identity + essential-story tier without a follow-up call. Cheap (no
      // I/O beyond the graph file already cached + an optional CLAUDE.md
      // read) and capped to ~600 tokens. CLIs that want depth use
      // /api/mind/query as before.
      let wakeup = null;
      if (stats) {
        try {
          const g = store.loadGraph(repoRoot, space);
          if (g) wakeup = composeWakeUp(g, {
            activeRepo: ui.activeRepo, activeRepoPath: ui.activeRepoPath, space,
            budgetTokens: 600,
            repoRoot,
          });
        } catch (_) { /* graph corrupt - skip wake-up, bootstrap still ships */ }
      }
      // Vector store presence: cheap (one filesystem stat) but skipped if
      // the graph is empty since vectors require a graph.
      let vectorsField = null;
      if (stats) {
        try {
          const vs = new VectorStore(repoRoot, space);
          vs.load();
          vectorsField = {
            enabled: vs.count() > 0,
            count: vs.count(),
            dim: vs.dim,
            provider: vs.provider,
            model: vs.model,
          };
        } catch (_) { /* ignore */ }
      }
      return {
        enabled: !!stats,
        scope: { space, isGlobal: false },
        graphStats: stats || null,
        wakeup,
        vectors: vectorsField,
        instructionsUrl: '/api/mind/instructions',
        queryUrl: '/api/mind/query',
        wakeupUrl: '/api/mind/wakeup',
        message: stats
          ? 'A shared knowledge graph exists for this space. For questions about CODE STRUCTURE call POST /api/mind/query. For questions about PRIOR WORK / PAST DECISIONS / WHAT DID WE FIGURE OUT call POST /api/mind/recall (returns memory cards + conversations ranked by topic + recency). When the user TEACHES you something durable ("remember:", "we decided", "always X", "never Y", "X has different Y", "prefer X", "watch out for"), call POST /api/mind/teach BEFORE answering — that is how the AI gets smarter across sessions. Save findings from regular Q&A via POST /api/mind/save-result, which also auto-extracts memory cards from teaching language in your answer.'
          : 'Mind graph is empty for this space. Run POST /api/mind/build to populate it.',
      };
    },

    // For orchestrator: invoked once per task completion, saves the result as
    // a conversation node so every future CLI (including the worker that
    // produced it) can find it via /api/mind/query.
    saveTaskToMind(task) {
      if (!task || !task.result) return;
      const space = (task.space || getSpace()) || '_global';
      let g = store.loadGraph(repoRoot, space) || store.emptyGraph({ space });
      const id = `task_${task.id}`;
      if (g.nodes.find(n => n.id === id)) return; // idempotent: already saved
      const promptSnippet = (typeof task.prompt === 'string' ? task.prompt : '').slice(0, 300);
      g.nodes.push({
        id, label: sanitizeLabel((promptSnippet || `${task.cli} task`).slice(0, 120)),
        kind: 'conversation',
        source: { type: 'orchestrator-task', ref: task.id, cli: task.cli, model: task.model },
        sourceLocation: null,
        createdBy: task.cli || 'orchestrator',
        createdAt: new Date(task.completedAt || Date.now()).toISOString(),
        tags: ['conversation', task.cli, task.from || ''].filter(Boolean),
        prompt: promptSnippet,
        result: sanitizeLabel(String(task.result).slice(0, 4000)),
      });
      // Tag with CLI so all per-CLI conversations cluster together.
      const cliId = `cli_${task.cli || 'unknown'}`;
      if (!g.nodes.find(n => n.id === cliId)) {
        g.nodes.push({
          id: cliId, label: sanitizeLabel(task.cli || 'unknown'), kind: 'tag',
          source: { type: 'cli', ref: task.cli }, sourceLocation: null,
          createdBy: 'mind/orchestrator-hook', createdAt: new Date().toISOString(), tags: [],
        });
      }
      g.edges.push({
        source: id, target: cliId, relation: 'tagged_with',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy: task.cli || 'orchestrator', createdAt: new Date().toISOString(),
      });
      try { persistDerivedGraph(space, g); } catch (_) { /* schema validation failure - non-fatal */ }
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'node-added', id, createdBy: task.cli } });
      notifyKnowledgeEvent({ kind: 'task-saved', nodeIds: [id], reason: 'orchestrator-task' });
    },

    // Public knowledge-event hook. Anything outside Mind that adds graph
    // state (learnings, notes, plugins) calls this so the brain reacts.
    notifyKnowledgeEvent,

    // For orchestrator: hint injected as prefix into dispatched prompts.
    //
    // Two-tier output:
    //   - Always: a one-line metadata stamp + query/save instructions.
    //   - When the graph has god nodes or recent conversations: append the
    //     L0+L1 wake-up (~400-700 tokens) so the worker starts with identity
    //     + essential-story context without making a /api/mind/wakeup call.
    //
    // The worker is still expected to call /api/mind/query for anything
    // specific - the hint is the wake-up, not the answer.
    // Run an incremental refresh on app startup so every session begins
    // with a fresh graph (new files since last shutdown, new app/site
    // recipes, new memory bullets). Fires a 'mind-startup-refresh' WS
    // event with phase: started | done | error so the UI can toast.
    // Idempotent: if a build is already in progress, this is a no-op.
    async kickoffStartupRefresh() {
      const space = getSpace();
      const acq = lock.acquire(space, 'graph');
      if (!acq.ok) {
        // A build is already running (likely the auto-resumed watcher).
        // Treat as success so the UI doesn't toast a stale error.
        if (broadcast) broadcast({ type: 'mind-startup-refresh', payload: { phase: 'skipped', reason: 'build already in progress', space } });
        return { ok: false, skipped: true, reason: 'busy' };
      }
      lock.release(space, 'graph');
      const startedAt = Date.now();
      if (broadcast) broadcast({ type: 'mind-startup-refresh', payload: { phase: 'started', space, startedAt } });
      try {
        const result = await engine.runBuild({
          repoRoot, space,
          sources: DEFAULT_BUILD_SOURCES,
          incremental: true,
          ctx,
          onProgress: () => { /* progress is internal; the UI just wants the toast */ },
        });
        if (broadcast) broadcast({
          type: 'mind-startup-refresh',
          payload: {
            phase: 'done', space,
            durationMs: Date.now() - startedAt,
            stats: store.statsFor(repoRoot, space),
            sources: Object.keys(result && result.sources ? result.sources : {}),
          },
        });
        return { ok: true, durationMs: Date.now() - startedAt };
      } catch (e) {
        if (broadcast) broadcast({ type: 'mind-startup-refresh', payload: { phase: 'error', space, error: e.message } });
        return { ok: false, error: e.message };
      }
    },

    orchestratorHint(opts = {}) {
      const space = getSpace();
      const stats = store.statsFor(repoRoot, space);
      if (!stats) return `[mind: ${space} empty]`;
      const ageMin = Math.round((Date.now() - new Date(stats.lastBuildAt).getTime()) / 60000);
      const stamp = `[mind: ${space} nodes=${stats.nodes} edges=${stats.edges} communities=${stats.communities} staleness=${ageMin}m] Query before answering: POST http://127.0.0.1:3800/api/mind/query {"question":"..."}. Save findings: POST /api/mind/save-result {"question","answer","citedNodeIds"}.`;
      // Apps + sites awareness: enumerate which apps and which sites have
      // automations indexed and how many are verified. Lets the dispatched
      // worker know up front that a recipe path exists without re-querying.
      // Two short lines, zero call cost.
      let appsLine = '';
      let sitesLine = '';
      try {
        const g = store.loadGraph(repoRoot, space);
        if (g && Array.isArray(g.nodes)) {
          const byApp = new Map();
          const bySite = new Map();
          for (const n of g.nodes) {
            if (n.kind !== 'recipe' || !Array.isArray(n.tags)) continue;
            if (n.tags.includes('app-automation')) {
              const appTag = n.tags.find(t => t !== 'app-automation' && t !== 'verified' && t !== 'draft' && t !== 'archived');
              if (appTag) {
                const slot = byApp.get(appTag) || { total: 0, verified: 0 };
                slot.total++;
                if (n.tags.includes('verified')) slot.verified++;
                byApp.set(appTag, slot);
              }
            }
            if (n.tags.includes('site-automation')) {
              const siteTag = n.tags.find(t => t !== 'site-automation' && t !== 'verified' && t !== 'draft' && t !== 'archived');
              if (siteTag) {
                const slot = bySite.get(siteTag) || { total: 0, verified: 0 };
                slot.total++;
                if (n.tags.includes('verified')) slot.verified++;
                bySite.set(siteTag, slot);
              }
            }
          }
          if (byApp.size) {
            const summary = [...byApp.entries()].slice(0, 8).map(([a, s]) => `${a}=${s.verified}/${s.total}`).join(' ');
            appsLine = `\n[apps: ${summary}] Use POST /api/apps/do { app, goal } to drive desktop apps; verified recipes replay without LLM tokens.`;
          }
          if (bySite.size) {
            const summary = [...bySite.entries()].slice(0, 8).map(([h, s]) => `${h}=${s.verified}/${s.total}`).join(' ');
            sitesLine = `\n[sites: ${summary}] Use POST /api/browser/router/run { goal, url } to drive websites; verified site recipes replay without LLM tokens.`;
          }
        }
      } catch (_) {}
      // Concatenate so legacy callers that read appsLine alone still work.
      appsLine = appsLine + sitesLine;
      if (opts.minimal) return stamp + appsLine;
      try {
        const g = store.loadGraph(repoRoot, space);
        if (!g) return stamp + appsLine;
        const ui = getUiContext ? getUiContext() : {};
        const wake = composeWakeUp(g, {
          activeRepo: ui.activeRepo, activeRepoPath: ui.activeRepoPath, space,
          budgetTokens: opts.budgetTokens || 600,
          question: opts.question || '',
          repoRoot,
        });
        return `${stamp}${appsLine}\n\n${wake.text}`;
      } catch (_) {
        return stamp + appsLine;
      }
    },
  };
}

module.exports = { mountMind };
