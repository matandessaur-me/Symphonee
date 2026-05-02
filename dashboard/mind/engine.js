/**
 * Engine: the build pipeline.
 *
 *   sources -> extractors -> build (merge, dedup, normalize) ->
 *   cluster -> analyze -> store
 *
 * One entry point: runBuild({ repoRoot, space, sources, incremental }).
 * Returns the new graph stats. Throws on shrink-without-prune.
 */

const path = require('path');
const fs = require('fs');
const store = require('./store');
const { Manifest } = require('./manifest');
const { build, buildMerge } = require('./build');
const { cluster } = require('./cluster');
const { analyze } = require('./analyze');
const lock = require('./lock');
const checkpoint = require('./checkpoint');
const embeddings = require('./embeddings');
const { VectorStore } = require('./vectors');

const { extractNotes } = require('./extractors/notes');
const { extractLearnings } = require('./extractors/learnings');
const { extractCliMemory } = require('./extractors/cli-memory');
const { extractCliSkills } = require('./extractors/cli-skills');
const { extractRecipes } = require('./extractors/recipes');
const { extractAppRecipes } = require('./extractors/app-recipes');
const { extractSiteMap } = require('./extractors/site-map');
const { extractPlugins } = require('./extractors/plugins');
const { extractInstructions } = require('./extractors/instructions');
const { extractRepoCode } = require('./extractors/repo-code');
const { extractCliHistory } = require('./extractors/cli-history');
const { extractCliDrawers } = require('./extractors/cli-drawers');
const { extractContextArtifacts } = require('./extractors/context-artifacts');
const { extractRepos } = require('./extractors/repos');
const { extractEntities } = require('./extractors/entities');
const adapterRegistry = require('./extractors/base');

async function runBuild({ repoRoot, space, sources = [], incremental = false, ctx = {}, onProgress = () => {} }) {
  const opName = incremental ? 'update' : 'build';
  const acq = lock.acquire(space, 'graph');
  if (!acq.ok) {
    const err = new Error(`mind graph operation already running (pid ${acq.holderPid || 'unknown'})`);
    err.code = 'MIND_LOCKED';
    err.holderPid = acq.holderPid || null;
    err.opName = opName;
    throw err;
  }
  try {
    return await _runBuildInner({ repoRoot, space, sources, incremental, ctx, onProgress });
  } finally {
    lock.release(space, 'graph');
  }
}

async function _runBuildInner({ repoRoot, space, sources = [], incremental = false, ctx = {}, onProgress = () => {} }) {
  const t0 = Date.now();
  const fragments = [];
  const summary = {};
  const cp = (phase, extra = {}) => checkpoint.write(repoRoot, space, { phase, sources, incremental, ...extra });
  cp('starting');

  const ui = ctx.getUiContext ? ctx.getUiContext() : {};
  const notesNamespace = ui.notesNamespace || space;
  const activeRepoPath = ui.activeRepoPath || null;
  const notesRoot = path.join(repoRoot, 'notes');
  const manifest = new Manifest(repoRoot, space);

  if (sources.includes('notes')) {
    cp('extract:notes');
    onProgress('Extracting notes...');
    const f = extractNotes({ repoRoot, notesNamespace, notesRoot, manifest, incremental });
    fragments.push(f); summary.notes = { scanned: f.scanned, skippedUnchanged: f.skippedUnchanged, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('learnings')) {
    onProgress('Extracting learnings...');
    const f = extractLearnings({ getLearnings: ctx.getLearnings });
    fragments.push(f); summary.learnings = { scanned: f.scanned, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('cli-memory')) {
    onProgress('Extracting CLI memory files...');
    const f = extractCliMemory({ repoRoot });
    fragments.push(f); summary.cliMemory = { scanned: f.scanned, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('cli-skills')) {
    onProgress('Extracting CLI skills/agents/plugins (claude / codex / qwen)...');
    const f = extractCliSkills();
    fragments.push(f); summary.cliSkills = { scanned: f.scanned, perSource: f.perSource, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('recipes')) {
    onProgress('Extracting recipes...');
    const f = extractRecipes({ repoRoot, manifest, incremental });
    fragments.push(f); summary.recipes = { scanned: f.scanned, skippedUnchanged: f.skippedUnchanged, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('app-recipes') || sources.includes('recipes')) {
    onProgress('Extracting app automations (recipes/memory/run-history)...');
    const f = extractAppRecipes({ manifest, incremental });
    fragments.push(f); summary.appRecipes = { scanned: f.scanned, skippedUnchanged: f.skippedUnchanged, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('site-map') || sources.includes('recipes')) {
    onProgress('Extracting site map (site-recipes / site-memory / page snapshots)...');
    const f = extractSiteMap({ manifest, incremental });
    fragments.push(f); summary.siteMap = { scanned: f.scanned, skippedUnchanged: f.skippedUnchanged, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('plugins')) {
    onProgress('Extracting plugins...');
    const f = extractPlugins({ getPlugins: ctx.getPlugins, getUiContext: ctx.getUiContext });
    fragments.push(f); summary.plugins = { scanned: f.scanned, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('instructions')) {
    onProgress('Extracting instructions...');
    const f = extractInstructions({ repoRoot, manifest, incremental });
    fragments.push(f); summary.instructions = { scanned: f.scanned, skippedUnchanged: f.skippedUnchanged, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('repo-code')) {
    // Always ingest every repo Symphonee knows about. The brain is meant to
    // span all connected projects so cross-project knowledge accumulates -
    // a single-active-repo build was the wrong default. Each node gets
    // tagged cwd:<repoName> via an in_repo edge. If getAllRepos isn't wired
    // (older callers), fall back to the active repo only.
    const repoMap = typeof ctx.getAllRepos === 'function' ? (ctx.getAllRepos() || {}) : {};
    const entries = Object.entries(repoMap).filter(([, p]) => typeof p === 'string' && p.length);
    if (!entries.length && activeRepoPath) entries.push(['__active__', activeRepoPath]);
    const totals = { scanned: 0, skippedCache: 0, nodes: 0, edges: 0, perRepo: {} };
    for (const [repoName, repoPath] of entries) {
      if (!repoPath) continue;
      onProgress(`Extracting repo code from ${repoName} (${repoPath})...`);
      const repoSlug = String(repoName).replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase();
      const f = extractRepoCode({ activeRepoPath: repoPath, manifest, idPrefix: `repo_${repoSlug}` });
      const tagId = `cwd_${repoSlug}`;
      f.nodes.push({ id: tagId, label: '@' + repoName, kind: 'tag' });
      const newEdges = f.nodes
        .filter(n => n.id !== tagId)
        .map(n => ({
          source: n.id,
          target: tagId,
          relation: 'in_repo',
          confidence: 'EXTRACTED',
          confidenceScore: 1,
          weight: 1,
          createdBy: 'mind/repo-code',
          createdAt: new Date().toISOString(),
        }));
      f.edges.push(...newEdges);
      fragments.push(f);
      totals.scanned += f.scanned;
      totals.skippedCache += f.skippedCache || 0;
      totals.nodes += f.nodes.length;
      totals.edges += f.edges.length;
      totals.perRepo[repoName] = { scanned: f.scanned, skippedCache: f.skippedCache, nodes: f.nodes.length, edges: f.edges.length };
    }
    summary.repoCode = totals;
  }

  if (sources.includes('cli-history')) {
    onProgress('Extracting CLI session history (claude / codex / gemini / grok / qwen / copilot)...');
    const f = extractCliHistory({ activeRepoPath, allRepos: !!ctx.cliHistoryAllRepos, manifest, incremental });
    fragments.push(f);
    summary.cliHistory = { scanned: f.scanned, skippedOtherRepo: f.skippedOtherRepo, skippedUnchanged: f.skippedUnchanged, perCli: f.perCli, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('cli-drawers')) {
    onProgress('Extracting verbatim CLI message drawers (claude / codex / qwen / grok / copilot)...');
    const f = extractCliDrawers({ activeRepoPath, allRepos: !!ctx.cliHistoryAllRepos, manifest, incremental });
    fragments.push(f);
    summary.cliDrawers = { scanned: f.scanned, skippedUnchanged: f.skippedUnchanged, skippedOtherRepo: f.skippedOtherRepo, drawers: f.drawersEmitted, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('context-artifacts')) {
    cp('extract:context-artifacts');
    onProgress('Extracting context artifacts (.symphonee/context-artifacts.json)...');
    const repoMap = typeof ctx.getAllRepos === 'function' ? (ctx.getAllRepos() || {}) : {};
    const entries = Object.entries(repoMap).filter(([, p]) => typeof p === 'string' && p.length);
    if (!entries.length && activeRepoPath) entries.push(['__active__', activeRepoPath]);
    const totals = { scanned: 0, skippedUnchanged: 0, nodes: 0, edges: 0, perRepo: {} };
    for (const [repoName, repoPath] of entries) {
      const f = extractContextArtifacts({ repoRoot, activeRepoPath: repoPath, manifest, incremental, repoName });
      fragments.push(f);
      totals.scanned += f.scanned || 0;
      totals.skippedUnchanged += f.skippedUnchanged || 0;
      totals.nodes += f.nodes.length;
      totals.edges += f.edges.length;
      totals.perRepo[repoName] = { scanned: f.scanned, skippedUnchanged: f.skippedUnchanged, nodes: f.nodes.length, edges: f.edges.length, configPath: f.configPath, error: f.error };
    }
    summary.contextArtifacts = totals;
  }

  // Third-party source adapters registered via dashboard/mind/extractors/base.js.
  // Plugins call `mindExtractors.register(adapter)` and the engine pulls
  // their fragments after the hardcoded ones. An adapter that throws is
  // logged and skipped — one bad plugin must not break the build.
  const adapters = adapterRegistry.list();
  if (adapters.length) {
    summary.adapters = {};
    for (const a of adapters) {
      const adapterName = a.name || (a.constructor && a.constructor.name) || 'unknown';
      onProgress(`Extracting from registered adapter: ${adapterName}...`);
      try {
        const adapterCtx = { repoRoot, space, activeRepoPath, manifest, ui, ctx };
        const totals = { nodes: 0, edges: 0, scanned: 0, skippedUnchanged: 0 };
        for await (const f of a.ingest(adapterCtx)) {
          if (!f) continue;
          fragments.push(f);
          totals.nodes += (f.nodes || []).length;
          totals.edges += (f.edges || []).length;
          totals.scanned += f.scanned || 0;
          totals.skippedUnchanged += f.skippedUnchanged || 0;
        }
        summary.adapters[adapterName] = { ...totals, version: a.constructor?.adapterVersion || a.adapterVersion || '0.0.0' };
      } catch (err) {
        summary.adapters[adapterName] = { error: err.message };
      }
    }
  }

  cp('merging');
  manifest.flushSync();

  onProgress('Merging fragments...');
  let graph;
  if (incremental) {
    const existing = store.loadGraph(repoRoot, space);
    graph = buildMerge(existing, fragments, { directed: true });
  } else {
    graph = build(fragments, { directed: true });
  }

  // ── Post-merge enrichment (Phase D + A) ───────────────────────────────────
  // These extractors read the fully-merged graph and synthesize new nodes /
  // edges on top. Pure additive: nothing existing is rewritten or removed.
  // We re-run build() to fold the synth fragments in so dedup, edge
  // sanitization, and the rest of the pipeline treat them like any other
  // fragment.
  const enrichmentFragments = [];
  if (sources.includes('repos')) {
    cp('enrich:repos');
    onProgress('Synthesizing first-class repo nodes...');
    const f = extractRepos(graph);
    enrichmentFragments.push(f);
    summary.repos = { scanned: f.scanned, repos: f.repos, nodes: f.nodes.length, edges: f.edges.length };
  }
  if (sources.includes('entities')) {
    cp('enrich:entities');
    onProgress('Synthesizing canonical entity layer (brands, products, projects)...');
    const seedEntities = (ctx && Array.isArray(ctx.seedEntities)) ? ctx.seedEntities : [];
    const f = extractEntities(graph, { seedEntities });
    enrichmentFragments.push(f);
    summary.entities = { scanned: f.scanned, entities: f.entities, mentions: f.mentions, nodes: f.nodes.length, edges: f.edges.length };
  }
  if (enrichmentFragments.length) {
    graph = build([{ nodes: graph.nodes, edges: graph.edges, hyperedges: graph.hyperedges }, ...enrichmentFragments], { directed: true });
  }

  onProgress(`Clustering ${graph.nodes.length} nodes...`);
  const { communities } = cluster(graph);

  onProgress('Analyzing god nodes and surprises...');
  const { gods, surprises, suggested } = analyze({ ...graph, communities });

  // Compose canonical graph object
  const out = {
    version: 1,
    scope: { space, isGlobal: false },
    generatedAt: new Date().toISOString(),
    nodes: graph.nodes,
    edges: graph.edges,
    hyperedges: graph.hyperedges || [],
    communities,
    gods, surprises, suggested,
    stats: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      communities: Object.keys(communities).length,
      tokenCost: graph.stats?.tokenCost || 0,
      buildMs: Date.now() - t0,
      sources: summary,
    },
  };

  cp('saving');
  onProgress(`Saving graph (${out.nodes.length} nodes, ${out.edges.length} edges)...`);
  const stats = store.saveGraph(repoRoot, space, out);

  // Optional report
  try {
    const report = renderReport(out);
    fs.writeFileSync(path.join(store.reportsDir(repoRoot, space), `report-${Date.now()}.md`), report, 'utf8');
  } catch (_) { /* non-fatal */ }

  // Best-effort embedding refresh. Gated behind SYMPHONEE_EMBED_AUTO=1 so we
  // don't surprise users with a network/model request on every build until
  // they opt in via Mind > settings.
  if (process.env.SYMPHONEE_EMBED_AUTO === '1') {
    try {
      cp('embedding');
      onProgress('Embedding nodes for semantic search...');
      await refreshEmbeddings({ repoRoot, space, graph: out, onProgress, ctx });
    } catch (err) {
      onProgress(`Embedding skipped: ${err.message}`);
    }
  }

  checkpoint.clear(repoRoot, space);
  return { stats, summary, buildMs: out.stats.buildMs };
}

// Builds (or refreshes) the vector store for the current graph.
// Embeds at most EMBED_MAX nodes; picks them in this priority:
//   gods -> code/symbol -> doc -> note -> conversation -> rest
async function refreshEmbeddings({ repoRoot, space, graph, onProgress = () => {}, ctx = {} }) {
  const provider = (ctx && ctx.embedProvider) || process.env.SYMPHONEE_EMBED_PROVIDER || embeddings.pickProvider();
  if (!provider) throw new Error('No embedding provider configured. Add an OpenAI or Google API key in Settings > AI Providers.');
  const EMBED_MAX = Number(process.env.SYMPHONEE_EMBED_MAX || 4000);
  const BATCH = Number(process.env.SYMPHONEE_EMBED_BATCH || 16);

  const candidates = pickEmbedCandidates(graph, EMBED_MAX);
  if (!candidates.length) return { embedded: 0, dim: 0, provider };

  const store_ = new VectorStore(repoRoot, space);
  store_.load();

  // Pull a quick health probe before we start so we fail fast if Ollama is
  // off rather than mid-batch.
  const health = await embeddings.health({ provider, fresh: true });
  if (!health.ok) throw new Error(`embed provider ${provider} unavailable: ${health.error}`);

  if (store_.dim && store_.dim !== health.dimensions) {
    onProgress(`Embedding dim changed (${store_.dim} -> ${health.dimensions}); rebuilding index`);
    store_.drop();
  }
  if (!store_.dim) store_.init({ dim: health.dimensions, provider, model: process.env.SYMPHONEE_EMBED_MODEL || null });

  let processed = 0;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    const texts = slice.map(c => c.text);
    let vectors;
    try {
      vectors = await embeddings.embed(texts, { provider });
    } catch (err) {
      onProgress(`Embed batch ${i}/${candidates.length} failed: ${err.message}`);
      break;
    }
    for (let j = 0; j < slice.length; j++) {
      if (!vectors[j]) continue;
      store_.upsert(slice[j].id, vectors[j]);
    }
    processed += slice.length;
    if (processed % 64 === 0) {
      store_.save();
      onProgress(`Embedded ${processed}/${candidates.length}`);
    }
  }
  store_.save();
  return { embedded: processed, dim: store_.dim, provider };
}

function pickEmbedCandidates(graph, max) {
  const out = [];
  const seen = new Set();
  const godIds = new Set((graph.gods || []).map(g => g.id || g));

  function pushNode(n) {
    if (!n || !n.id || seen.has(n.id)) return;
    const text = embedText(n);
    if (!text) return;
    seen.add(n.id);
    out.push({ id: n.id, text });
  }

  // Priority 1: gods.
  for (const n of graph.nodes) if (godIds.has(n.id)) pushNode(n);
  // Priority 2: code/symbol/doc/note/conversation/artifact in that order.
  for (const order of ['code', 'doc', 'note', 'concept', 'recipe', 'plugin', 'workitem', 'conversation']) {
    if (out.length >= max) break;
    for (const n of graph.nodes) {
      if (out.length >= max) break;
      if (n.kind === order) pushNode(n);
    }
  }
  // Anything else.
  for (const n of graph.nodes) {
    if (out.length >= max) break;
    pushNode(n);
  }
  return out;
}

function embedText(node) {
  const parts = [node.label || ''];
  if (Array.isArray(node.tags) && node.tags.length) parts.push(node.tags.join(' '));
  if (node.description) parts.push(node.description);
  if (node.summary) parts.push(node.summary);
  if (node.answer) parts.push(node.answer);
  if (node.source && node.source.ref) parts.push(node.source.ref);
  const t = parts.join(' \n ').trim();
  if (!t) return null;
  return t.slice(0, 4000);
}

function renderReport(graph) {
  const lines = [];
  lines.push(`# Mind report — ${graph.scope.space}`);
  lines.push('');
  lines.push(`Generated: ${graph.generatedAt}`);
  lines.push(`Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length} | Communities: ${Object.keys(graph.communities).length}`);
  lines.push('');
  lines.push('## God nodes');
  for (const g of graph.gods.slice(0, 10)) lines.push(`- **${g.label}** (\`${g.id}\`) — degree ${g.degree}`);
  lines.push('');
  lines.push('## Surprising connections');
  for (const s of graph.surprises.slice(0, 10)) lines.push(`- ${s.source} ↔ ${s.target} (${s.relation}, ${s.confidence}, communities ${s.crossesCommunities.join(' / ')})`);
  lines.push('');
  lines.push('## Communities');
  for (const [cid, c] of Object.entries(graph.communities).slice(0, 20)) {
    lines.push(`- **#${cid} ${c.label}** — ${c.size} nodes, cohesion ${c.cohesion}`);
  }
  return lines.join('\n');
}

module.exports = { runBuild, refreshEmbeddings };
