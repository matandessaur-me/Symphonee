/**
 * Site-Map extractor. Walks dashboard/site-recipes/<host>.json,
 * dashboard/site-memory/<host>.md, dashboard/site-snapshots/<host>/*.json,
 * and dashboard/site-recipe-history/<host>.json. Each becomes a node so
 * any CLI can ask Mind "what automations exist for reddit.com?" or "how
 * do I search across sites?" and get a routable answer.
 *
 * Edges:
 *   recipe   -- targets    --> site_<host>
 *   recipe   -- tagged_with --> site_verb_<tag>          (login, search, ...)
 *   page     -- belongs_to  --> site_<host>
 *   recipe   -- visits      --> page                     (when first GOTO matches)
 *   memory   -- describes   --> site_<host>
 *   run      -- ran         --> recipe
 */

const fs = require('fs');
const path = require('path');
const { sanitizeLabel } = require('../security');
const { makeIdFromLabel } = require('../ids');

const RECIPES_DIR = path.join(__dirname, '..', '..', 'site-recipes');
const MEMORY_DIR = path.join(__dirname, '..', '..', 'site-memory');
const SNAPSHOT_DIR = path.join(__dirname, '..', '..', 'site-snapshots');
const HISTORY_DIR = path.join(__dirname, '..', '..', 'site-recipe-history');

function _safeJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function _safeText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }
function _list(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  try { return fs.readdirSync(dir).filter(f => f.endsWith(ext)); } catch (_) { return []; }
}
function _listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  try { return fs.readdirSync(dir).filter(f => {
    try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch (_) { return false; }
  }); } catch (_) { return []; }
}

function _siteId(host) { return `site_${makeIdFromLabel(host)}`; }
function _verbId(tag) { return `site_verb_${makeIdFromLabel(tag)}`; }
function _pageId(host, pathHash) { return `page_${makeIdFromLabel(host)}_${pathHash}`; }

function extractSiteMap({ createdBy = 'mind/site-map', manifest = null, incremental = false } = {}) {
  const nodes = []; const edges = [];
  let scanned = 0; let skippedUnchanged = 0;
  const now = () => new Date().toISOString();

  const seenSites = new Set();
  function ensureSiteNode(host) {
    const sid = _siteId(host);
    if (seenSites.has(sid)) return sid;
    seenSites.add(sid);
    nodes.push({
      id: sid, label: sanitizeLabel(host), kind: 'concept',
      source: { type: 'site', ref: host }, sourceLocation: null,
      createdBy, createdAt: now(), tags: ['site', 'site-automation'],
    });
    return sid;
  }
  function ensureVerbNode(tag) {
    const vid = _verbId(tag);
    nodes.push({
      id: vid, label: sanitizeLabel('site-verb:' + tag), kind: 'tag',
      source: { type: 'site-verb', ref: tag }, sourceLocation: null,
      createdBy, createdAt: now(), tags: ['site-automation-verb'],
    });
    return vid;
  }

  // ── Recipes ─────────────────────────────────────────────────────────────
  for (const f of _list(RECIPES_DIR, '.json')) {
    const full = path.join(RECIPES_DIR, f);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
    const key = `site-recipes:${full}`;
    if (incremental && manifest) {
      const prev = manifest.get(key);
      if (prev && prev.mtimeMs === mtimeMs) { skippedUnchanged++; continue; }
    }
    const data = _safeJson(full);
    if (!data || !Array.isArray(data.recipes)) continue;
    if (manifest) manifest.set(key, { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs });
    scanned++;
    const host = String(data.host || f.replace(/\.json$/i, ''));
    const siteNode = ensureSiteNode(host);

    for (const r of data.recipes) {
      const rid = `site_recipe_${makeIdFromLabel(host)}_${makeIdFromLabel(r.id || r.name || 'unnamed')}`;
      nodes.push({
        id: rid,
        label: sanitizeLabel(`${host}: ${r.name || r.id}`),
        kind: 'recipe',
        source: { type: 'site-recipe', ref: r.id, file: full, host },
        sourceLocation: null,
        createdBy, createdAt: now(),
        tags: ['site-automation', host, r.status || 'verified'].filter(Boolean),
        description: r.description || null,
        steps: Array.isArray(r.steps) ? r.steps.length : 0,
        successCount: r.successCount || 0,
      });
      edges.push({
        source: rid, target: siteNode, relation: 'targets',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: now(),
      });
      const conceptTags = Array.isArray(r.conceptTags) ? r.conceptTags : [];
      for (const t of conceptTags) {
        const vid = ensureVerbNode(t);
        edges.push({
          source: rid, target: vid, relation: 'tagged_with',
          confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 0.8,
          createdBy, createdAt: now(),
        });
      }
      // First GOTO step links the recipe to the page it lands on, so
      // queries like "what runs against reddit.com/r/programming" can
      // walk the graph rather than string-match every step.
      const firstGoto = (Array.isArray(r.steps) ? r.steps : []).find(s => s.verb === 'GOTO' && s.target);
      if (firstGoto) {
        try {
          const u = new URL(firstGoto.target);
          const pathHash = require('crypto').createHash('md5').update(u.pathname + (u.search || '')).digest('hex').slice(0, 12);
          const pid = _pageId(host, pathHash);
          nodes.push({
            id: pid, label: sanitizeLabel(`${host}${u.pathname || '/'}`), kind: 'page',
            source: { type: 'page', ref: firstGoto.target, host },
            sourceLocation: null,
            createdBy, createdAt: now(),
            tags: ['site-page', host],
            url: firstGoto.target,
          });
          edges.push({
            source: pid, target: siteNode, relation: 'belongs_to',
            confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
            createdBy, createdAt: now(),
          });
          edges.push({
            source: rid, target: pid, relation: 'visits',
            confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 0.9,
            createdBy, createdAt: now(),
          });
        } catch (_) { /* malformed URL — skip page link */ }
      }
      if (r.sourceSessionId) {
        const sid = `session_${makeIdFromLabel(r.sourceSessionId)}`;
        edges.push({
          source: rid, target: sid, relation: 'recorded_from',
          confidence: 'INFERRED', confidenceScore: 0.6, weight: 0.5,
          createdBy, createdAt: now(),
        });
      }
    }
  }

  // ── Per-host markdown memory ────────────────────────────────────────────
  for (const f of _list(MEMORY_DIR, '.md')) {
    const full = path.join(MEMORY_DIR, f);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
    const key = `site-memory:${full}`;
    if (incremental && manifest) {
      const prev = manifest.get(key);
      if (prev && prev.mtimeMs === mtimeMs) { skippedUnchanged++; continue; }
    }
    const text = _safeText(full);
    if (!text) continue;
    if (manifest) manifest.set(key, { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs });
    scanned++;
    const host = f.replace(/\.md$/i, '');
    const siteNode = ensureSiteNode(host);
    const mid = `site_memory_${makeIdFromLabel(host)}`;
    nodes.push({
      id: mid, label: sanitizeLabel(`${host} memory`), kind: 'doc',
      source: { type: 'site-memory', ref: host, file: full },
      sourceLocation: { file: full },
      createdBy, createdAt: now(),
      tags: ['site-memory', host],
      description: text.slice(0, 600),
    });
    edges.push({
      source: mid, target: siteNode, relation: 'describes',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: now(),
    });
  }

  // ── Cached page DOM digests (one node per snapshotted page) ─────────────
  for (const hostDir of _listDirs(SNAPSHOT_DIR)) {
    const dir = path.join(SNAPSHOT_DIR, hostDir);
    const siteNode = ensureSiteNode(hostDir);
    for (const f of _list(dir, '.json')) {
      const full = path.join(dir, f);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
      const key = `site-snapshot:${full}`;
      if (incremental && manifest) {
        const prev = manifest.get(key);
        if (prev && prev.mtimeMs === mtimeMs) { skippedUnchanged++; continue; }
      }
      const data = _safeJson(full);
      if (!data) continue;
      if (manifest) manifest.set(key, { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs });
      scanned++;
      const ph = data.pathHash || f.replace(/\.json$/i, '');
      const pid = _pageId(hostDir, ph);
      nodes.push({
        id: pid, label: sanitizeLabel(`${hostDir} snapshot ${ph}`), kind: 'page',
        source: { type: 'page-snapshot', ref: data.url || ph, host: hostDir, file: full },
        sourceLocation: null,
        createdBy, createdAt: now(),
        tags: ['site-page', hostDir, 'snapshot'],
        url: data.url || null,
        digestHash: data.digestHash || null,
      });
      edges.push({
        source: pid, target: siteNode, relation: 'belongs_to',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: now(),
      });
    }
  }

  // ── Run history (per-host JSON file) ────────────────────────────────────
  for (const f of _list(HISTORY_DIR, '.json')) {
    const full = path.join(HISTORY_DIR, f);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
    const key = `site-recipe-history:${full}`;
    if (incremental && manifest) {
      const prev = manifest.get(key);
      if (prev && prev.mtimeMs === mtimeMs) { skippedUnchanged++; continue; }
    }
    const data = _safeJson(full);
    if (!data || !Array.isArray(data.runs)) continue;
    if (manifest) manifest.set(key, { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs });
    scanned++;
    const host = f.replace(/\.json$/i, '');
    for (const entry of data.runs.slice(0, 30)) {
      if (!entry || !entry.recipeId) continue;
      const rid = `site_recipe_${makeIdFromLabel(host)}_${makeIdFromLabel(entry.recipeId)}`;
      const runId = `site_recipe_run_${makeIdFromLabel(host)}_${makeIdFromLabel(entry.id || entry.at || String(Math.random()))}`;
      nodes.push({
        id: runId,
        label: sanitizeLabel(`${host} run: ${entry.recipeName || entry.recipeId} (${entry.outcome || '?'})`),
        kind: 'conversation',
        source: { type: 'site-recipe-run', ref: entry.id || null, file: full },
        sourceLocation: null,
        createdBy, createdAt: now(),
        tags: ['site-recipe-run', host, entry.outcome || 'unknown'],
        description: entry.error || null,
      });
      edges.push({
        source: runId, target: rid, relation: 'ran',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: now(),
      });
    }
  }

  return { nodes, edges, scanned, skippedUnchanged };
}

module.exports = { extractSiteMap };
