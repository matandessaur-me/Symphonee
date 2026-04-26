/**
 * Mind storage layer.
 *
 * Canonical graph state lives at:
 *   <repoRoot>/.symphonee/mind/spaces/<space>/graph.json
 *
 * The file is human-readable JSON so it shows up in the Symphonee diff viewer
 * and can be hand-edited or grepped without a tool. Per-space partitioning
 * keeps any single graph from growing unbounded.
 *
 * Writes are atomic (write-to-temp + rename) so a crash mid-write cannot
 * corrupt the canonical file.
 */

const fs = require('fs');
const path = require('path');
const { emptyGraph, validateGraph } = require('./schema');

function namespaceFromSpace(space) {
  if (!space) return '_global';
  return space.toString().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64) || '_global';
}

function mindRoot(repoRoot) {
  return path.join(repoRoot, '.symphonee', 'mind');
}

function spaceDir(repoRoot, space) {
  return path.join(mindRoot(repoRoot), 'spaces', namespaceFromSpace(space));
}

function graphPath(repoRoot, space) {
  return path.join(spaceDir(repoRoot, space), 'graph.json');
}

function cacheDir(repoRoot, space) {
  return path.join(spaceDir(repoRoot, space), 'cache');
}

function reportsDir(repoRoot, space) {
  return path.join(spaceDir(repoRoot, space), 'reports');
}

function ensureDirs(repoRoot, space) {
  const dirs = [spaceDir(repoRoot, space), cacheDir(repoRoot, space), reportsDir(repoRoot, space)];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadGraph(repoRoot, space) {
  const p = graphPath(repoRoot, space);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try { return JSON.parse(raw); } catch (e) {
    throw new Error(`mind/store: graph.json for space "${space}" is corrupt: ${e.message}`);
  }
}

function saveGraph(repoRoot, space, graph) {
  ensureDirs(repoRoot, space);
  const errors = validateGraph(graph);
  if (errors.length) {
    throw new Error(`mind/store: refusing to save invalid graph: ${errors.slice(0, 3).join('; ')}`);
  }
  graph.generatedAt = new Date().toISOString();
  graph.stats = {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    communities: Object.keys(graph.communities || {}).length,
    tokenCost: (graph.stats && graph.stats.tokenCost) || 0,
  };
  atomicWrite(graphPath(repoRoot, space), JSON.stringify(graph, null, 2));
  return graph.stats;
}

function listSpaces(repoRoot) {
  const root = path.join(mindRoot(repoRoot), 'spaces');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(f => {
    try { return fs.statSync(path.join(root, f)).isDirectory(); } catch (_) { return false; }
  });
}

function statsFor(repoRoot, space) {
  const g = loadGraph(repoRoot, space);
  if (!g) return null;
  const lastBuildAt = g.generatedAt;
  return {
    nodes: g.stats?.nodes ?? g.nodes.length,
    edges: g.stats?.edges ?? g.edges.length,
    communities: g.stats?.communities ?? Object.keys(g.communities || {}).length,
    lastBuildAt,
    tokenCost: g.stats?.tokenCost ?? 0,
  };
}

module.exports = {
  namespaceFromSpace,
  mindRoot,
  spaceDir,
  graphPath,
  cacheDir,
  reportsDir,
  ensureDirs,
  loadGraph,
  saveGraph,
  listSpaces,
  statsFor,
  emptyGraph,
};
