/**
 * Impact / call-flow / symbol-context analysis on the Mind graph.
 *
 * The graph already carries:
 *   - nodes: { id, kind, label, sourceLocation: { file, line }, source: { type, ref, file, ... } }
 *   - edges with relations: 'imports', 'defines', 'calls', plus others
 *
 * Symbol nodes (kind:'code', source.type:'symbol') reference their parent file
 * via 'defines' edges. This module wires the BFS / DFS traversals on top.
 */

const path = require('path');

function indexEdges(edges) {
  const out = new Map();
  for (const e of edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e);
  }
  return out;
}

function indexReverse(edges) {
  const out = new Map();
  for (const e of edges) {
    if (!out.has(e.target)) out.set(e.target, []);
    out.get(e.target).push(e);
  }
  return out;
}

function findSymbols(graph, name) {
  const out = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'code') continue;
    if (!n.source || n.source.type !== 'symbol') continue;
    const label = String(n.label || '').replace(/\(\)$/, '');
    if (label === name || n.source.ref === name) out.push(n);
  }
  return out;
}

function fileNodeOf(graph, fileRel) {
  return graph.nodes.find(n =>
    n.kind === 'code'
    && n.source && n.source.type === 'file'
    && n.source.ref === fileRel,
  ) || null;
}

function symbolsInFile(graph, fileRel) {
  return graph.nodes.filter(n =>
    n.kind === 'code'
    && n.source && n.source.type === 'symbol'
    && (n.source.file === fileRel || (n.sourceLocation && n.sourceLocation.file === fileRel)),
  );
}

function fileOfNode(node) {
  if (!node) return null;
  if (node.source && node.source.type === 'symbol' && node.source.file) return node.source.file;
  if (node.sourceLocation && node.sourceLocation.file) return node.sourceLocation.file;
  if (node.source && node.source.ref) return node.source.ref;
  return null;
}

function looksLikeFilePath(target) {
  return /[\\/]/.test(target) || /\.[a-zA-Z0-9]{1,5}$/.test(target);
}

// ── Impact / blast radius ────────────────────────────────────────────────────

function getImpact(graph, target, depth = 3) {
  const safeDepth = Math.max(1, Math.min(depth, 8));
  const reverse = indexReverse(graph.edges);

  // Resolve target to seed file paths.
  const seedFiles = new Set();
  if (looksLikeFilePath(target)) {
    seedFiles.add(target);
  } else {
    const matches = findSymbols(graph, target);
    for (const sym of matches) {
      const f = fileOfNode(sym);
      if (f) seedFiles.add(f);
    }
  }

  if (seedFiles.size === 0) {
    return { target, targetKind: 'unknown', filesByDepth: {}, totalFiles: 0, truncated: false };
  }

  // For each seed file, find its file-node id, then walk reverse 'calls' and
  // 'imports' edges through symbols to collect caller files.
  const fileToId = new Map();
  for (const n of graph.nodes) {
    if (n.kind !== 'code') continue;
    if (n.source && n.source.type === 'file' && n.source.ref) fileToId.set(n.source.ref, n.id);
  }

  const visited = new Set(); // file rel paths
  const filesByDepth = {};
  let frontier = new Set(seedFiles);
  for (const f of seedFiles) visited.add(f);

  function callersOfFile(fileRel) {
    const out = new Set();
    // 1. anyone whose 'imports' edge points at this file's node id
    const fileNodeId = fileToId.get(fileRel);
    if (fileNodeId) {
      for (const e of reverse.get(fileNodeId) || []) {
        if (e.relation !== 'imports') continue;
        const fromNode = graph.nodes.find(n => n.id === e.source);
        const fromFile = fileOfNode(fromNode);
        if (fromFile && fromFile !== fileRel) out.add(fromFile);
      }
    }
    // 2. anyone whose 'calls' edge points at a symbol defined in this file
    const fileSymbols = symbolsInFile(graph, fileRel);
    for (const sym of fileSymbols) {
      for (const e of reverse.get(sym.id) || []) {
        if (e.relation !== 'calls') continue;
        const fromNode = graph.nodes.find(n => n.id === e.source);
        const fromFile = fileOfNode(fromNode);
        if (fromFile && fromFile !== fileRel) out.add(fromFile);
      }
    }
    return out;
  }

  let truncated = false;
  for (let hop = 1; hop <= safeDepth; hop++) {
    const next = new Set();
    for (const f of frontier) {
      for (const caller of callersOfFile(f)) {
        if (visited.has(caller)) continue;
        next.add(caller);
        visited.add(caller);
      }
    }
    if (next.size === 0) break;
    filesByDepth[String(hop)] = Array.from(next).sort();
    frontier = next;
    if (hop === safeDepth) {
      for (const f of frontier) {
        for (const caller of callersOfFile(f)) {
          if (!visited.has(caller)) { truncated = true; break; }
        }
        if (truncated) break;
      }
    }
  }

  let totalFiles = 0;
  for (const arr of Object.values(filesByDepth)) totalFiles += arr.length;
  return {
    target,
    targetKind: looksLikeFilePath(target) ? 'file' : 'symbol',
    seedFiles: Array.from(seedFiles),
    filesByDepth,
    totalFiles,
    truncated,
    depth: safeDepth,
  };
}

// ── Forward call-flow (DFS) ──────────────────────────────────────────────────

function getCallFlow(graph, entrypoint, depth = 5) {
  const safeDepth = Math.max(1, Math.min(depth, 10));
  const fwd = indexEdges(graph.edges);

  let seed;
  if (looksLikeFilePath(entrypoint)) {
    const fNode = fileNodeOf(graph, entrypoint);
    seed = fNode || null;
  } else {
    const matches = findSymbols(graph, entrypoint);
    seed = matches[0] || null;
  }
  if (!seed) return null;

  const visited = new Set();
  function walk(node, hop) {
    const file = fileOfNode(node);
    const out = {
      id: node.id,
      label: node.label,
      file,
      line: node.sourceLocation && node.sourceLocation.line || null,
      children: [],
    };
    if (visited.has(node.id)) { out.truncated = 'cycle'; return out; }
    visited.add(node.id);
    if (hop >= safeDepth) { out.truncated = 'depth'; return out; }
    const edges = fwd.get(node.id) || [];
    for (const e of edges) {
      if (e.relation !== 'calls' && e.relation !== 'defines') continue;
      const target = graph.nodes.find(n => n.id === e.target);
      if (!target) continue;
      out.children.push(walk(target, hop + 1));
    }
    return out;
  }
  return walk(seed, 0);
}

// ── Symbol context (360° view) ───────────────────────────────────────────────

function getSymbolContext(graph, name, fileHint) {
  const matches = findSymbols(graph, name).filter(n => !fileHint || fileOfNode(n) === fileHint);
  if (matches.length === 0) return [];
  const fwd = indexEdges(graph.edges);
  const reverse = indexReverse(graph.edges);
  const out = [];
  for (const sym of matches) {
    const callees = (fwd.get(sym.id) || [])
      .filter(e => e.relation === 'calls')
      .map(e => {
        const t = graph.nodes.find(n => n.id === e.target);
        return {
          id: e.target,
          name: t && t.label,
          file: fileOfNode(t),
          confidence: e.confidence,
          confidenceScore: e.confidenceScore,
        };
      });
    const callers = (reverse.get(sym.id) || [])
      .filter(e => e.relation === 'calls')
      .map(e => {
        const c = graph.nodes.find(n => n.id === e.source);
        return {
          id: e.source,
          name: c && c.label,
          file: fileOfNode(c),
          confidence: e.confidence,
          confidenceScore: e.confidenceScore,
        };
      });
    out.push({
      id: sym.id,
      name: sym.label,
      file: fileOfNode(sym),
      line: sym.sourceLocation && sym.sourceLocation.line || null,
      callers,
      callees,
    });
  }
  return out;
}

// ── List symbols ─────────────────────────────────────────────────────────────

function listSymbols(graph, { file, query, limit = 200 } = {}) {
  const out = [];
  for (const n of graph.nodes) {
    if (n.kind !== 'code') continue;
    if (!n.source || n.source.type !== 'symbol') continue;
    if (file) {
      const f = fileOfNode(n);
      if (f !== file) continue;
    }
    if (query) {
      const q = String(query).toLowerCase();
      if (!String(n.label || '').toLowerCase().includes(q)) continue;
    }
    out.push({
      id: n.id,
      name: n.label,
      file: fileOfNode(n),
      line: n.sourceLocation && n.sourceLocation.line || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Entrypoint detection ─────────────────────────────────────────────────────

const ENTRY_NAMES = new Set(['main', 'handler', 'run', 'start', 'bootstrap', 'init']);
const ENTRY_PATTERNS = [
  /\bindex\.(t|j)sx?$/,
  /\bserver\.(t|j)sx?$/,
  /\bmain\.(t|j)sx?$/,
  /\bcli\.(t|j)sx?$/,
  /\bapp\.(t|j)sx?$/,
];

function detectEntrypoints(graph) {
  const reverse = indexReverse(graph.edges);
  const out = [];

  for (const n of graph.nodes) {
    if (n.kind !== 'code') continue;
    const reasons = [];

    if (n.source && n.source.type === 'symbol') {
      const name = String(n.source.ref || n.label || '').replace(/\(\)$/, '');
      if (ENTRY_NAMES.has(name)) reasons.push('well-known-name:' + name);
    }

    if (n.source && n.source.type === 'file' && n.source.ref) {
      const file = n.source.ref;
      for (const pat of ENTRY_PATTERNS) if (pat.test(file)) reasons.push('filename');
      // file orphans: nothing imports them
      const refs = (reverse.get(n.id) || []).filter(e => e.relation === 'imports');
      if (refs.length === 0 && /\.(t|j)sx?$/.test(file)) reasons.push('file-orphan');
    }

    if (reasons.length) {
      out.push({
        id: n.id,
        label: n.label,
        file: fileOfNode(n),
        line: n.sourceLocation && n.sourceLocation.line || null,
        reasons,
      });
    }
  }

  // Sort: symbols-with-name first, then orphan files
  out.sort((a, b) => b.reasons.length - a.reasons.length);
  return out.slice(0, 100);
}

// ── Circular dependency detection (Tarjan SCC over file imports) ────────────

function detectCircular(graph) {
  // Collect file nodes + their 'imports' edges to other file nodes only.
  const fileIds = new Set();
  for (const n of graph.nodes) {
    if (n.kind !== 'code' || !n.source || n.source.type !== 'file') continue;
    fileIds.add(n.id);
  }
  const adj = new Map();
  for (const id of fileIds) adj.set(id, []);
  for (const e of graph.edges) {
    if (e.relation !== 'imports') continue;
    if (!fileIds.has(e.source) || !fileIds.has(e.target)) continue;
    adj.get(e.source).push(e.target);
  }

  // Iterative Tarjan to avoid stack-overflow on large graphs.
  let index = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  for (const start of adj.keys()) {
    if (indices.has(start)) continue;
    const work = [{ id: start, iter: 0 }];
    indices.set(start, index); lowlinks.set(start, index); index++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const neighbors = adj.get(frame.id) || [];
      if (frame.iter < neighbors.length) {
        const w = neighbors[frame.iter++];
        if (!indices.has(w)) {
          indices.set(w, index); lowlinks.set(w, index); index++;
          stack.push(w); onStack.add(w);
          work.push({ id: w, iter: 0 });
        } else if (onStack.has(w)) {
          lowlinks.set(frame.id, Math.min(lowlinks.get(frame.id), indices.get(w)));
        }
      } else {
        if (lowlinks.get(frame.id) === indices.get(frame.id)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== frame.id);
          if (comp.length > 1) sccs.push(comp);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].id;
          lowlinks.set(parent, Math.min(lowlinks.get(parent), lowlinks.get(frame.id)));
        }
      }
    }
  }

  // Map ids back to file paths for human reading.
  const idToFile = new Map();
  for (const n of graph.nodes) {
    if (fileIds.has(n.id)) idToFile.set(n.id, n.source && n.source.ref || n.label);
  }
  return sccs.map(comp => comp.map(id => idToFile.get(id) || id));
}

module.exports = {
  getImpact,
  getCallFlow,
  getSymbolContext,
  listSymbols,
  detectEntrypoints,
  detectCircular,
  // helpers for tests
  _findSymbols: findSymbols,
  _fileOfNode: fileOfNode,
};
