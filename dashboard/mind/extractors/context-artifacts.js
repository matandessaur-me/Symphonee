/**
 * Context-artifacts extractor.
 *
 * Reads <repoRoot>/.symphonee/context-artifacts.json (one per active repo)
 * which declares non-code knowledge - schemas, OpenAPI specs, ADRs,
 * domain glossaries - that the AI should consult before making decisions
 * in the relevant area.
 *
 * Schema:
 *   { artifacts: [
 *     { name: "schema",
 *       path: "./docs/schema.sql",
 *       description: "Postgres schema. Check before writing migrations." },
 *     ...
 *   ] }
 *
 * Each artifact emits one or more nodes (kind: 'artifact'). The description
 * is stored on the node so semantic search returns it AND the AI sees it
 * in the wake-up context. Files inside a directory artifact each become a
 * sub-node connected to the artifact group via 'contains' edges.
 */

const fs = require('fs');
const path = require('path');
const { sanitizeLabel } = require('../security');
const { makeIdFromLabel, normalizeId } = require('../ids');
const { hashContent } = require('../manifest');

const CONFIG_NAME = '.symphonee/context-artifacts.json';
const MAX_FILE_BYTES = 500 * 1024;
const ALLOWED_EXTS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.adoc',
  '.sql', '.prisma', '.schema',
  '.yaml', '.yml', '.json', '.toml', '.xml', '.ini',
  '.proto', '.graphql', '.openapi',
]);

function loadConfig(repoRoot) {
  const candidate = path.join(repoRoot, CONFIG_NAME);
  if (!fs.existsSync(candidate)) return { configPath: candidate, artifacts: [] };
  try {
    const cfg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    return {
      configPath: candidate,
      artifacts: Array.isArray(cfg.artifacts) ? cfg.artifacts : [],
    };
  } catch (e) {
    return { configPath: candidate, artifacts: [], error: e.message };
  }
}

function listArtifactFiles(absPath) {
  const out = [];
  if (!fs.existsSync(absPath)) return out;
  let stat;
  try { stat = fs.statSync(absPath); } catch (_) { return out; }
  if (stat.isFile()) {
    out.push(absPath);
    return out;
  }
  if (stat.isDirectory()) {
    const stack = [absPath];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { stack.push(full); continue; }
        const ext = path.extname(ent.name).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) continue;
        out.push(full);
      }
    }
  }
  return out;
}

function extractContextArtifacts({ repoRoot, activeRepoPath, createdBy = 'mind/context-artifacts', manifest = null, incremental = false, repoName = null }) {
  const root = activeRepoPath || repoRoot;
  if (!root || !fs.existsSync(root)) return { nodes: [], edges: [], scanned: 0 };
  const cfg = loadConfig(root);
  if (!cfg.artifacts.length) {
    return { nodes: [], edges: [], scanned: 0, configPath: cfg.configPath, error: cfg.error };
  }

  const nodes = [];
  const edges = [];
  let scanned = 0;
  let skippedUnchanged = 0;

  for (const a of cfg.artifacts) {
    if (!a || !a.name || !a.path) continue;
    const idScope = repoName ? `${repoName}_${a.name}` : a.name;
    const groupId = `artifact_${normalizeId(idScope)}`;
    const absPath = path.isAbsolute(a.path) ? a.path : path.resolve(root, a.path);
    const files = listArtifactFiles(absPath);

    nodes.push({
      id: groupId,
      label: sanitizeLabel(a.name),
      kind: 'artifact',
      source: { type: 'artifact', ref: a.path, root: root, repo: repoName || null },
      sourceLocation: { file: a.path },
      createdBy,
      createdAt: new Date().toISOString(),
      tags: ['artifact', `artifact:${a.name}`].concat(repoName ? [`cwd:${repoName}`] : []),
      description: sanitizeLabel(String(a.description || '').slice(0, 1000)),
      summary: sanitizeLabel(String(a.description || '').slice(0, 240)),
      fileCount: files.length,
    });

    for (const full of files) {
      const rel = path.relative(root, full).replace(/\\/g, '/');
      let buf;
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        buf = fs.readFileSync(full);
      } catch (_) { continue; }
      const sha = hashContent(buf);
      const key = `artifact:${idScope}:${rel}`;
      if (incremental && manifest) {
        const prev = manifest.get(key);
        if (prev && prev.sha256 === sha) { skippedUnchanged++; continue; }
      }
      const fileId = makeIdFromLabel(`artifact_${idScope}_${rel}`, 'artifact');
      const text = buf.toString('utf8');
      nodes.push({
        id: fileId,
        label: sanitizeLabel(path.basename(rel)),
        kind: 'artifact',
        source: { type: 'artifact-file', ref: rel, file: full, artifact: a.name, repo: repoName || null },
        sourceLocation: { file: rel },
        createdBy,
        createdAt: new Date().toISOString(),
        tags: ['artifact-file', `artifact:${a.name}`, path.extname(rel).slice(1) || 'plain'].concat(repoName ? [`cwd:${repoName}`] : []),
        description: sanitizeLabel(`${a.description || ''} (${rel})`.slice(0, 1000)),
        summary: sanitizeLabel(text.split(/\r?\n/).slice(0, 6).join(' ').slice(0, 400)),
      });
      edges.push({
        source: groupId, target: fileId, relation: 'contains',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
      if (manifest) manifest.set(key, { sha256: sha, lastExtractedAt: Date.now(), contributors: [createdBy] });
      scanned++;
    }
  }

  return { nodes, edges, scanned, skippedUnchanged, configPath: cfg.configPath };
}

function readArtifactsConfig(activeRepoPath, repoRoot) {
  const root = activeRepoPath || repoRoot;
  return loadConfig(root);
}

module.exports = { extractContextArtifacts, readArtifactsConfig, CONFIG_NAME };
