/**
 * Repo code + doc extractor.
 *
 * Walks activeRepoPath. For each file:
 *   - .ts/.tsx/.js/.jsx/.mjs/.cjs: regex-based JS/TS extractor (imports,
 *     exports, function/class declarations, top-level call sites).
 *   - .md/.mdx: generic markdown extractor (wikilinks, links, headings).
 *   - .py/.cs: lightweight regex pull of class/function declarations.
 *
 * Tree-sitter is the production-grade swap-in for the JS/TS extractor. It is
 * intentionally not a dep yet because (a) tree-sitter binaries need an
 * Electron rebuild, (b) the regex extractor proves the pipeline end-to-end.
 *
 * Per-file SHA256 cache lives at .symphonee/mind/spaces/<space>/cache/<sha>.json
 * via the manifest. Files unchanged since last extract are skipped entirely.
 */

const fs = require('fs');
const path = require('path');
const { sanitizeLabel } = require('../security');
const { makeIdFromLabel, normalizeId } = require('../ids');
const { extractMarkdown } = require('./markdown');
const { hashContent } = require('../manifest');
const { loadPathAliases } = require('../aliases');
const { resolveImport: resolveImportSmart } = require('../resolve-import');
const { extractMultiLang, langOf: multiLangOf, supportedExts: multiLangExts } = require('./code-langs');

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.cs',
  ...multiLangExts(),
]);
const DOC_EXT = new Set(['.md', '.mdx']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out',
  '.cache', 'coverage', '.symphonee', '.ai-workspace', '__pycache__',
]);
const MAX_FILE_BYTES = 250 * 1024;
const MAX_FILES = 5000;

function* walk(rootDir) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.gitignore') {
        // skip dotted dirs/files except gitignore
        if (ent.isDirectory()) continue;
      }
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      yield full;
    }
  }
}

function fileExt(p) { return path.extname(p).toLowerCase(); }

// ── JS/TS ────────────────────────────────────────────────────────────────────

const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/gm;
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
const FN_DECL_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
const ARROW_FN_RE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(?\s*[^)]*\)?\s*=>/gm;
const CLASS_DECL_RE = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

function extractJsTs({ relPath, fullPath, body, repoRoot, createdBy, aliases, fileSet }) {
  const id = makeIdFromLabel(relPath, 'code');
  const nodes = [{
    id, label: sanitizeLabel(path.basename(relPath)),
    kind: 'code',
    source: { type: 'file', ref: relPath, file: fullPath },
    sourceLocation: { file: relPath },
    createdBy, createdAt: new Date().toISOString(), tags: ['code', fileExt(relPath).slice(1)],
  }];
  const edges = [];

  // Imports
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(body))) {
    const { target, unresolved } = resolveOne(m[1], relPath, aliases, fileSet);
    edges.push({
      source: id, target, relation: 'imports',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: new Date().toISOString(),
      ...(unresolved ? { unresolved: true, spec: m[1] } : {}),
    });
  }
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(body))) {
    const { target, unresolved } = resolveOne(m[1], relPath, aliases, fileSet);
    edges.push({
      source: id, target, relation: 'imports',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: new Date().toISOString(),
      ...(unresolved ? { unresolved: true, spec: m[1] } : {}),
    });
  }

  // Declarations as sub-nodes
  for (const re of [FN_DECL_RE, ARROW_FN_RE, CLASS_DECL_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(body))) {
      const name = m[1];
      const subId = `${id}__${normalizeId(name)}`;
      nodes.push({
        id: subId, label: sanitizeLabel(`${name}()`),
        kind: 'code',
        source: { type: 'symbol', ref: name, file: relPath },
        sourceLocation: { file: relPath, line: body.slice(0, m.index).split('\n').length },
        createdBy, createdAt: new Date().toISOString(), tags: ['symbol'],
      });
      edges.push({
        source: id, target: subId, relation: 'defines',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }
  }

  // Top-level call sites: collect raw_calls now, resolve later in a post-pass.
  const rawCalls = [];
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(body))) {
    const name = m[1];
    if (JS_KEYWORDS.has(name)) continue;
    rawCalls.push(name);
  }

  return { nodes, edges, rawCalls: { from: id, names: Array.from(new Set(rawCalls)) } };
}

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'async', 'function',
  'class', 'const', 'let', 'var', 'new', 'typeof', 'instanceof', 'do', 'try',
  'throw', 'import', 'export', 'require', 'this', 'super', 'yield',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Promise', 'Map', 'Set',
  'console', 'JSON', 'Math', 'Date',
]);

function resolveImport(spec, fromRel) {
  // legacy resolver kept for callers that don't pass alias context
  if (spec.startsWith('.')) {
    const dir = path.posix.dirname(fromRel.replace(/\\/g, '/'));
    const cleaned = path.posix.normalize(`${dir}/${spec}`).replace(/^\.\//, '');
    return makeIdFromLabel(cleaned, 'code');
  }
  return `pkg_${normalizeId(spec)}`;
}

function resolveOne(spec, fromRel, aliases, fileSet) {
  return resolveOneInner(spec, fromRel, aliases, fileSet, null);
}

function resolveOneInner(spec, fromRel, aliases, fileSet, kindHint) {
  if (fileSet) {
    const kind = kindHint || (spec.match(/\.(css|scss|sass|less|styl)$/) ? 'css' : 'js');
    const real = resolveImportSmart({
      spec, fromFile: fromRel, fileSet, aliases, kind,
    });
    if (real) return { target: makeIdFromLabel(real, 'code'), unresolved: false };
  }
  if (spec.startsWith('.')) {
    const dir = path.posix.dirname(fromRel.replace(/\\/g, '/'));
    const cleaned = path.posix.normalize(`${dir}/${spec}`).replace(/^\.\//, '');
    return { target: makeIdFromLabel(cleaned, 'code'), unresolved: false };
  }
  return { target: `ext_${normalizeId(spec)}`, unresolved: true };
}

// ── Python / C# (very lightweight) ───────────────────────────────────────────

const PY_DECL_RE = /^\s*(?:def|class)\s+([A-Za-z_][\w]*)/gm;
const CS_DECL_RE = /^\s*(?:public|private|internal|protected|static)?\s*(?:async\s+)?(?:class|interface|struct|enum|void|Task|[A-Z][\w]*)\s+([A-Z][\w]+)\s*[(\{<]/gm;

function extractPyOrCs({ relPath, fullPath, body, createdBy, kindLabel }) {
  const id = makeIdFromLabel(relPath, 'code');
  const nodes = [{
    id, label: sanitizeLabel(path.basename(relPath)),
    kind: 'code',
    source: { type: 'file', ref: relPath, file: fullPath },
    sourceLocation: { file: relPath },
    createdBy, createdAt: new Date().toISOString(), tags: ['code', kindLabel],
  }];
  const edges = [];
  const re = (kindLabel === 'py') ? PY_DECL_RE : CS_DECL_RE;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    const subId = `${id}__${normalizeId(name)}`;
    nodes.push({
      id: subId, label: sanitizeLabel(name),
      kind: 'code',
      source: { type: 'symbol', ref: name, file: relPath },
      sourceLocation: { file: relPath, line: body.slice(0, m.index).split('\n').length },
      createdBy, createdAt: new Date().toISOString(), tags: ['symbol'],
    });
    edges.push({
      source: id, target: subId, relation: 'defines',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: new Date().toISOString(),
    });
  }
  return { nodes, edges, rawCalls: null };
}

// ── Cross-file call resolution (post-pass) ───────────────────────────────────

function resolveCalls(allRawCalls, allNodes, createdBy) {
  // Build symbol-name -> nodeId map (from `defines` sub-nodes whose label ends with `()`).
  const nameToIds = new Map();
  for (const n of allNodes) {
    if (n.kind !== 'code') continue;
    const m = (n.label || '').match(/^([A-Za-z_$][\w$]*)/);
    if (!m) continue;
    const name = m[1];
    if (!nameToIds.has(name)) nameToIds.set(name, []);
    nameToIds.get(name).push(n.id);
  }
  const edges = [];
  for (const { from, names } of allRawCalls) {
    for (const name of names) {
      const targets = nameToIds.get(name);
      if (!targets || targets.length === 0) continue;
      // If multiple targets, INFERRED (we can't disambiguate without scope).
      const conf = targets.length === 1 ? 'EXTRACTED' : 'INFERRED';
      const score = targets.length === 1 ? 1.0 : Math.max(0.3, 1.0 / targets.length);
      for (const tgt of targets) {
        if (tgt === from) continue;
        edges.push({
          source: from, target: tgt, relation: 'calls',
          confidence: conf, confidenceScore: score, weight: 0.5,
          createdBy, createdAt: new Date().toISOString(),
        });
      }
    }
  }
  return edges;
}

// ── Driver ───────────────────────────────────────────────────────────────────

function extractRepoCode({ activeRepoPath, manifest, createdBy = 'mind/repo-code', limit = MAX_FILES }) {
  if (!activeRepoPath || !fs.existsSync(activeRepoPath)) {
    return { nodes: [], edges: [], scanned: 0, skippedCache: 0 };
  }
  // Pass 1 - collect file set (relative posix paths) so the alias resolver
  // can verify candidates exist on disk before emitting an edge.
  const fileSet = new Set();
  const seen = [];
  for (const full of walk(activeRepoPath)) {
    if (seen.length >= limit) break;
    const ext = fileExt(full);
    if (!CODE_EXT.has(ext) && !DOC_EXT.has(ext)) continue;
    const rel = path.relative(activeRepoPath, full).replace(/\\/g, '/');
    fileSet.add(rel);
    seen.push({ full, rel, ext });
  }
  const aliases = loadPathAliases(activeRepoPath);

  const allNodes = [];
  const allEdges = [];
  const allRawCalls = [];
  let scanned = 0, skippedCache = 0;

  for (const { full, rel, ext } of seen) {
    let buf;
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(full);
    } catch (_) { continue; }
    const sha = hashContent(buf);

    // Skip unchanged files when an incremental run is happening (manifest hit).
    const prev = manifest && manifest.get(rel);
    if (prev && prev.sha256 === sha && prev.cachedFragment) {
      try {
        const cached = JSON.parse(prev.cachedFragment);
        allNodes.push(...cached.nodes);
        allEdges.push(...cached.edges);
        if (cached.rawCalls) allRawCalls.push(cached.rawCalls);
        skippedCache++;
        continue;
      } catch (_) { /* fall through and re-extract */ }
    }

    const body = buf.toString('utf8');
    let frag;
    if (DOC_EXT.has(ext)) {
      const id = makeIdFromLabel(rel, 'doc');
      frag = extractMarkdown({
        id, label: rel, kind: 'doc',
        source: { type: 'doc', ref: rel, file: full },
        body, createdBy, tagPrefix: 'doc',
      });
      frag.rawCalls = null;
    } else if (ext === '.py') {
      frag = extractPyOrCs({ relPath: rel, fullPath: full, body, createdBy, kindLabel: 'py' });
    } else if (ext === '.cs') {
      frag = extractPyOrCs({ relPath: rel, fullPath: full, body, createdBy, kindLabel: 'cs' });
    } else if (multiLangOf(ext)) {
      frag = extractMultiLang({
        relPath: rel, fullPath: full, body,
        lang: multiLangOf(ext),
        createdBy, aliases, fileSet,
        resolveOne: (spec, fromRel, a, fset, kind) => resolveOneInner(spec, fromRel, a, fset, kind),
      });
      if (frag) frag.rawCalls = null;
      else frag = { nodes: [], edges: [], rawCalls: null };
    } else {
      frag = extractJsTs({ relPath: rel, fullPath: full, body, repoRoot: activeRepoPath, createdBy, aliases, fileSet });
    }

    allNodes.push(...frag.nodes);
    allEdges.push(...frag.edges);
    if (frag.rawCalls) allRawCalls.push(frag.rawCalls);

    if (manifest) {
      manifest.set(rel, {
        sha256: sha, lastExtractedAt: Date.now(),
        contributors: [createdBy],
        cachedFragment: JSON.stringify({ nodes: frag.nodes, edges: frag.edges, rawCalls: frag.rawCalls }),
      });
    }
    scanned++;
  }

  // Post-pass: resolve cross-file calls.
  const callEdges = resolveCalls(allRawCalls, allNodes, createdBy);
  allEdges.push(...callEdges);

  return { nodes: allNodes, edges: allEdges, scanned, skippedCache, aliasesUsed: aliases.aliases.length };
}

module.exports = { extractRepoCode, walk };
