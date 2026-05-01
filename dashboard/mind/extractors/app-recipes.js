/**
 * App-Recipes extractor. Walks dashboard/app-recipes/<app>.json,
 * dashboard/app-memory/<app>.md, and dashboard/app-recipe-history/<app>.jsonl.
 * Each recipe becomes a node so any CLI can ask Mind "what automations exist
 * for app X?" or "how do I do Y across apps?" and get a routable answer.
 *
 * Edges:
 *   recipe -- targets --> app_concept_<app>
 *   recipe -- tagged_with --> concept_<tag>      (login, export, search, ...)
 *   recipe -- recorded_from --> session_<id>    (when sourceSessionId is set)
 *   app_memory_section -- describes --> app_concept_<app>
 *   recipe_run_<runId> -- ran --> recipe         (per recorded run)
 */

const fs = require('fs');
const path = require('path');
const { sanitizeLabel } = require('../security');
const { makeIdFromLabel } = require('../ids');

const RECIPES_DIR = path.join(__dirname, '..', '..', 'app-recipes');
const MEMORY_DIR = path.join(__dirname, '..', '..', 'app-memory');
const HISTORY_DIR = path.join(__dirname, '..', '..', 'app-recipe-history');

function _safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function _safeReadText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}
function _list(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  try { return fs.readdirSync(dir).filter(f => f.endsWith(ext)); } catch (_) { return []; }
}

function _appConceptId(app) { return `app_concept_${makeIdFromLabel(app)}`; }
function _conceptId(tag)    { return `app_verb_${makeIdFromLabel(tag)}`; }

function extractAppRecipes({ createdBy = 'mind/app-recipes', manifest = null, incremental = false } = {}) {
  const nodes = []; const edges = [];
  let scanned = 0; let skippedUnchanged = 0;
  const now = () => new Date().toISOString();

  const seenAppNodes = new Set();
  function ensureAppNode(app) {
    const aid = _appConceptId(app);
    if (seenAppNodes.has(aid)) return aid;
    seenAppNodes.add(aid);
    nodes.push({
      id: aid, label: sanitizeLabel(app), kind: 'concept',
      source: { type: 'app', ref: app }, sourceLocation: null,
      createdBy, createdAt: now(), tags: ['app', 'app-automation'],
    });
    return aid;
  }
  function ensureConceptNode(tag) {
    const cid = _conceptId(tag);
    nodes.push({
      id: cid, label: sanitizeLabel('verb:' + tag), kind: 'tag',
      source: { type: 'app-verb', ref: tag }, sourceLocation: null,
      createdBy, createdAt: now(), tags: ['app-automation-verb'],
    });
    return cid;
  }

  // ── Recipes ─────────────────────────────────────────────────────────────
  for (const f of _list(RECIPES_DIR, '.json')) {
    const full = path.join(RECIPES_DIR, f);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
    const key = `app-recipes:${full}`;
    if (incremental && manifest) {
      const prev = manifest.get(key);
      if (prev && prev.mtimeMs === mtimeMs) { skippedUnchanged++; continue; }
    }
    const data = _safeReadJson(full);
    if (!data || !Array.isArray(data.recipes)) continue;
    if (manifest) manifest.set(key, { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs });
    scanned++;
    const app = String(data.app || f.replace(/\.json$/i, ''));
    const appNode = ensureAppNode(app);

    for (const r of data.recipes) {
      const rid = `app_recipe_${makeIdFromLabel(app)}_${makeIdFromLabel(r.id || r.name || 'unnamed')}`;
      nodes.push({
        id: rid,
        label: sanitizeLabel(`${app}: ${r.name || r.id}`),
        kind: 'recipe',
        source: { type: 'app-recipe', ref: r.id, file: full, app },
        sourceLocation: null,
        createdBy, createdAt: now(),
        tags: ['app-automation', app, r.status || 'verified'].filter(Boolean),
        description: r.description || null,
        steps: Array.isArray(r.steps) ? r.steps.length : 0,
        successCount: r.successCount || 0,
      });
      edges.push({
        source: rid, target: appNode, relation: 'targets',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: now(),
      });
      const conceptTags = Array.isArray(r.conceptTags) ? r.conceptTags : [];
      for (const t of conceptTags) {
        const cid = ensureConceptNode(t);
        edges.push({
          source: rid, target: cid, relation: 'tagged_with',
          confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 0.8,
          createdBy, createdAt: now(),
        });
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

  // ── App memory (per-app markdown notes the agent writes during sessions) ─
  for (const f of _list(MEMORY_DIR, '.md')) {
    const full = path.join(MEMORY_DIR, f);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
    const key = `app-memory:${full}`;
    if (incremental && manifest) {
      const prev = manifest.get(key);
      if (prev && prev.mtimeMs === mtimeMs) { skippedUnchanged++; continue; }
    }
    const text = _safeReadText(full);
    if (!text) continue;
    if (manifest) manifest.set(key, { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs });
    scanned++;
    const app = f.replace(/\.md$/i, '');
    const appNode = ensureAppNode(app);
    const mid = `app_memory_${makeIdFromLabel(app)}`;
    nodes.push({
      id: mid, label: sanitizeLabel(`${app} memory`), kind: 'doc',
      source: { type: 'app-memory', ref: app, file: full },
      sourceLocation: { file: full },
      createdBy, createdAt: now(),
      tags: ['app-memory', app],
      description: text.slice(0, 600),
    });
    edges.push({
      source: mid, target: appNode, relation: 'describes',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: now(),
    });
  }

  // ── Run history (per recorded run, lightweight conversation-like nodes) ─
  // Stored per-app as .json with shape { app, runs: [{ id, at, recipeId,
  // recipeName, outcome, ... }] }. Cap to last 30 runs to keep the graph lean.
  for (const f of _list(HISTORY_DIR, '.json')) {
    const full = path.join(HISTORY_DIR, f);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
    const key = `app-recipe-history:${full}`;
    if (incremental && manifest) {
      const prev = manifest.get(key);
      if (prev && prev.mtimeMs === mtimeMs) { skippedUnchanged++; continue; }
    }
    const data = _safeReadJson(full);
    if (!data || !Array.isArray(data.runs)) continue;
    if (manifest) manifest.set(key, { sha256: '', lastExtractedAt: Date.now(), contributors: [], mtimeMs });
    scanned++;
    const app = f.replace(/\.json$/i, '');
    for (const entry of data.runs.slice(0, 30)) {
      if (!entry || !entry.recipeId) continue;
      const rid = `app_recipe_${makeIdFromLabel(app)}_${makeIdFromLabel(entry.recipeId)}`;
      const runId = `app_recipe_run_${makeIdFromLabel(app)}_${makeIdFromLabel(entry.id || entry.at || String(Math.random()))}`;
      nodes.push({
        id: runId,
        label: sanitizeLabel(`${app} run: ${entry.recipeName || entry.recipeId} (${entry.outcome || '?'})`),
        kind: 'conversation',
        source: { type: 'app-recipe-run', ref: entry.id || null, file: full },
        sourceLocation: null,
        createdBy, createdAt: now(),
        tags: ['app-recipe-run', app, entry.outcome || 'unknown'],
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

module.exports = { extractAppRecipes };
