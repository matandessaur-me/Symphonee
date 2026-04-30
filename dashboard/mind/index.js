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
const lock = require('./lock');
const checkpoint = require('./checkpoint');
const impact = require('./impact');
const embeddings = require('./embeddings');
const { VectorStore } = require('./vectors');
const viz = require('./viz');

// In-memory job table for build/update progress. Jobs are ephemeral; the
// canonical graph on disk is the system of record.
const jobs = new Map();
const DEFAULT_BUILD_SOURCES = ['notes', 'learnings', 'cli-memory', 'cli-skills', 'recipes', 'plugins', 'instructions', 'repo-code', 'cli-history', 'cli-drawers', 'context-artifacts'];
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
  const provider = vs.provider || process.env.SYMPHONEE_EMBED_PROVIDER || 'ollama';
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
  const { repoRoot, getUiContext, getLearnings, getPlugins, getNotesDir, broadcast } = ctx;

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
    const existing = lock.status(space, 'build');
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

    const existing = lock.status(space, 'update');
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
      watch: lock.status(space, 'watch'),
      all: lock.listAll(),
    });
  });

  addRoute('POST', '/api/mind/lock/clear', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const op = body.op || 'build';
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
    const space = getSpace();
    const ui = getUiContext ? getUiContext() : {};
    const { readArtifactsConfig } = require('./extractors/context-artifacts');
    const cfg = readArtifactsConfig(ui.activeRepoPath, repoRoot);
    const g = store.loadGraph(repoRoot, space);
    const indexedByName = new Map();
    if (g) {
      for (const n of g.nodes) {
        if (n.kind !== 'artifact') continue;
        if (!n.source || n.source.type !== 'artifact') continue;
        indexedByName.set(n.label, n);
      }
    }
    const enriched = (cfg.artifacts || []).map(a => ({
      name: a.name,
      path: a.path,
      description: a.description || '',
      indexed: indexedByName.has(a.name),
      fileCount: indexedByName.get(a.name)?.fileCount || 0,
    }));
    return json(res, {
      space,
      configPath: cfg.configPath,
      configExists: !!cfg.configPath && require('fs').existsSync(cfg.configPath),
      error: cfg.error || null,
      artifacts: enriched,
    });
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
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const acq = lock.acquire(space, 'embed');
    if (!acq.ok) return json(res, { error: 'embedding already running', holderPid: acq.holderPid }, 409);
    json(res, { ok: true, started: true, provider: body.provider || 'ollama' });
    try {
      const r = await engine.refreshEmbeddings({
        repoRoot, space, graph: g,
        ctx: { embedProvider: body.provider || process.env.SYMPHONEE_EMBED_PROVIDER || 'ollama' },
        onProgress: (msg) => {
          if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-progress', msg } });
        },
      });
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-complete', result: r } });
    } catch (err) {
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'embed-failed', error: err.message } });
    } finally {
      lock.release(space, 'embed');
    }
  });

  // ── Health (embeddings + vectors store status) ───────────────────────────
  addRoute('GET', '/api/mind/health', async (req, res) => {
    const space = getSpace();
    const vs = new VectorStore(repoRoot, space);
    vs.load();
    const url = new URL(req.url, 'http://x');
    const provider = url.searchParams.get('provider') || process.env.SYMPHONEE_EMBED_PROVIDER || 'ollama';
    const fresh = url.searchParams.get('fresh') === '1';
    const h = await embeddings.health({ provider, fresh });
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
    return json(res, { ok: true, nodeId: id, audit, groundedCount: grounded.length });
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
    return json(res, { ok: true, nodeId: id });
  });

  // ── Watch mode ───────────────────────────────────────────────────────────
  let watcher = null;
  // Watch always re-ingests every Symphonee-managed repo on each tick. Mind
  // is meant to span all connected projects.
  const triggerIncrementalUpdate = async (changedFiles) => {
    const space = getSpace();
    const jobId = makeJobId();
    const job = { id: jobId, kind: 'watch-update', space, status: 'running', startedAt: Date.now(), progress: [], trigger: { changedFiles } };
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

  addRoute('POST', '/api/mind/watch', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const enabled = body.enabled !== false;
    if (!enabled) {
      if (watcher) { watcher.stop(); watcher = null; }
      return json(res, { enabled: false });
    }
    if (watcher) watcher.stop();
    watcher = new MindWatcher({
      repoRoot, getUiContext: ctx.getUiContext, broadcast,
      debounceMs: typeof body.debounceMs === 'number' ? body.debounceMs : 3000,
      onTrigger: triggerIncrementalUpdate,
    });
    watcher.start();
    return json(res, { enabled: true, debounceMs: watcher.debounceMs });
  });

  addRoute('GET', '/api/mind/watch', (req, res) => {
    return json(res, { enabled: !!(watcher && watcher._enabled) });
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
          ? 'A shared knowledge graph exists for this space. Call POST /api/mind/query before answering questions about this codebase, notes, or prior decisions. Save new findings via POST /api/mind/save-result.'
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
    },

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
    orchestratorHint(opts = {}) {
      const space = getSpace();
      const stats = store.statsFor(repoRoot, space);
      if (!stats) return `[mind: ${space} empty]`;
      const ageMin = Math.round((Date.now() - new Date(stats.lastBuildAt).getTime()) / 60000);
      const stamp = `[mind: ${space} nodes=${stats.nodes} edges=${stats.edges} communities=${stats.communities} staleness=${ageMin}m] Query before answering: POST http://127.0.0.1:3800/api/mind/query {"question":"..."}. Save findings: POST /api/mind/save-result {"question","answer","citedNodeIds"}.`;
      if (opts.minimal) return stamp;
      try {
        const g = store.loadGraph(repoRoot, space);
        if (!g) return stamp;
        const ui = getUiContext ? getUiContext() : {};
        // When the orchestrator passes the worker's task prompt as opts.question,
        // L1 becomes the BFS sub-graph for that task. Otherwise it's the
        // generic "god nodes + recent conversations" view.
        const wake = composeWakeUp(g, {
          activeRepo: ui.activeRepo, activeRepoPath: ui.activeRepoPath, space,
          budgetTokens: opts.budgetTokens || 600,
          question: opts.question || '',
        });
        return `${stamp}\n\n${wake.text}`;
      } catch (_) {
        return stamp;
      }
    },
  };
}

module.exports = { mountMind };
