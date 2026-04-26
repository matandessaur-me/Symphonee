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

const { extractNotes } = require('./extractors/notes');
const { extractLearnings } = require('./extractors/learnings');
const { extractCliMemory } = require('./extractors/cli-memory');
const { extractRecipes } = require('./extractors/recipes');
const { extractPlugins } = require('./extractors/plugins');
const { extractInstructions } = require('./extractors/instructions');
const { extractRepoCode } = require('./extractors/repo-code');

async function runBuild({ repoRoot, space, sources = [], incremental = false, ctx = {}, onProgress = () => {} }) {
  const t0 = Date.now();
  const fragments = [];
  const summary = {};

  const ui = ctx.getUiContext ? ctx.getUiContext() : {};
  const notesNamespace = ui.notesNamespace || space;
  const activeRepoPath = ui.activeRepoPath || null;
  const notesRoot = path.join(repoRoot, 'notes');
  const manifest = new Manifest(repoRoot, space);

  if (sources.includes('notes')) {
    onProgress('Extracting notes...');
    const f = extractNotes({ repoRoot, notesNamespace, notesRoot });
    fragments.push(f); summary.notes = { scanned: f.scanned, nodes: f.nodes.length, edges: f.edges.length };
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

  if (sources.includes('recipes')) {
    onProgress('Extracting recipes...');
    const f = extractRecipes({ repoRoot });
    fragments.push(f); summary.recipes = { scanned: f.scanned, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('plugins')) {
    onProgress('Extracting plugins...');
    const f = extractPlugins({ getPlugins: ctx.getPlugins, getUiContext: ctx.getUiContext });
    fragments.push(f); summary.plugins = { scanned: f.scanned, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('instructions')) {
    onProgress('Extracting instructions...');
    const f = extractInstructions({ repoRoot });
    fragments.push(f); summary.instructions = { scanned: f.scanned, nodes: f.nodes.length, edges: f.edges.length };
  }

  if (sources.includes('repo-code')) {
    onProgress(`Extracting repo code from ${activeRepoPath || '(no active repo path)'}...`);
    const f = extractRepoCode({ activeRepoPath, manifest });
    fragments.push(f); summary.repoCode = { scanned: f.scanned, skippedCache: f.skippedCache, nodes: f.nodes.length, edges: f.edges.length };
  }

  manifest.flushSync();

  onProgress('Merging fragments...');
  let graph;
  if (incremental) {
    const existing = store.loadGraph(repoRoot, space);
    graph = buildMerge(existing, fragments, { directed: true });
  } else {
    graph = build(fragments, { directed: true });
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

  onProgress(`Saving graph (${out.nodes.length} nodes, ${out.edges.length} edges)...`);
  const stats = store.saveGraph(repoRoot, space, out);

  // Optional report
  try {
    const report = renderReport(out);
    fs.writeFileSync(path.join(store.reportsDir(repoRoot, space), `report-${Date.now()}.md`), report, 'utf8');
  } catch (_) { /* non-fatal */ }

  return { stats, summary, buildMs: out.stats.buildMs };
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

module.exports = { runBuild };
