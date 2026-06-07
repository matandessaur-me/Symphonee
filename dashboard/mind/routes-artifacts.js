'use strict';
// Mind context-artifacts: list / suggest / init / search declared repo artifacts.

const store = require('./store');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace, getUiContext, readBody, ctx, tryDenseSeeds } = deps;

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
}

module.exports = { register };
