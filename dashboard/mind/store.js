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
const { emptyGraph, validateGraph, validateNode, validateEdge } = require('./schema');

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

function repairGraph(graph, validationErrors) {
  const warnings = [];
  const out = {
    ...graph,
    nodes: [],
    edges: [],
    hyperedges: Array.isArray(graph.hyperedges) ? graph.hyperedges : [],
    communities: graph.communities && typeof graph.communities === 'object' ? graph.communities : {},
    gods: Array.isArray(graph.gods) ? graph.gods : [],
    surprises: Array.isArray(graph.surprises) ? graph.surprises : [],
    suggested: Array.isArray(graph.suggested) ? graph.suggested : [],
    stats: graph.stats && typeof graph.stats === 'object' ? { ...graph.stats } : {},
  };

  const ids = new Set();
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    const err = validateNode(node);
    if (err) {
      warnings.push('Dropped node: ' + err);
      continue;
    }
    if (ids.has(node.id)) {
      warnings.push('Dropped duplicate node id: ' + node.id);
      continue;
    }
    ids.add(node.id);
    out.nodes.push(node);
  }

  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    const err = validateEdge(edge, ids);
    if (err) {
      warnings.push('Dropped edge: ' + err);
      continue;
    }
    out.edges.push(edge);
  }

  const surviving = new Set(out.nodes.map(n => n.id));
  out.edges = out.edges.filter(edge => {
    const ok = surviving.has(edge.source) && surviving.has(edge.target);
    if (!ok) warnings.push(`Dropped dangling edge: ${edge.source || '?'} -> ${edge.target || '?'}`);
    return ok;
  });

  out.stats.validationErrors = validationErrors.slice(0, 20);
  out.stats.validationWarnings = warnings.slice(0, 50);
  out.stats.validationWarningCount = warnings.length;
  return out;
}

function saveGraph(repoRoot, space, graph) {
  ensureDirs(repoRoot, space);
  let errors = validateGraph(graph);
  if (errors.length) {
    graph = repairGraph(graph, errors);
    errors = validateGraph(graph);
    if (errors.length) {
      throw new Error(`mind/store: refusing to save invalid graph after repair: ${errors.slice(0, 3).join('; ')}`);
    }
  }
  graph.generatedAt = new Date().toISOString();
  // Preserve any additional stats fields the engine populated (sources,
  // buildMs, etc.) and only overlay the canonical counts.
  graph.stats = {
    ...(graph.stats || {}),
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
