'use strict';
// Mind proactive insights: list / suggestions / generate / act / dismiss / snooze.
// generateInsights + the hourly scheduler stay in the controller; this module
// only registers the HTTP surface.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const lock = require('./lock');
const insights = require('./insights');
const memoryModule = require('./memory');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace, getUiContext, readBody, broadcast, notifyKnowledgeEvent, generateInsights } = deps;

  // GET /api/mind/insights?status=pending|acted|dismissed|snoozed|all
  addRoute('GET', '/api/mind/insights', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const status = url.searchParams.get('status') || 'pending';
    const space = getSpace();
    const items = insights.listInsights({ repoRoot, space, status });
    return json(res, { items, count: items.length, status });
  });

  // GET /api/mind/suggestions?topic=<text>&limit=<n>
  // The "is there anything we can do?" surface. Returns pending insights
  // ranked by relevance to the topic (BM25 against title + body). If no
  // topic is given, returns all pending insights sorted by recency. CLIs
  // call this when the user asks for suggestions.
  addRoute('GET', '/api/mind/suggestions', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const topic = (url.searchParams.get('topic') || '').trim();
    const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
    const space = getSpace();
    let items = insights.listInsights({ repoRoot, space, status: 'pending' });
    if (topic) {
      // Cheap BM25-style scoring without pulling in the full index.
      // Each insight scores by how many topic terms appear in its
      // searchable text (label + body + category + payload labels).
      const terms = topic.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length >= 3);
      items = items.map(it => {
        const blob = [
          it.label, it.body, it.category,
          it.action && it.action.payload && it.action.payload.title,
          it.action && it.action.payload && it.action.payload.description,
          ...(Array.isArray(it.action && it.action.payload && it.action.payload.tags) ? it.action.payload.tags : []),
        ].filter(Boolean).join(' ').toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (blob.indexOf(t) !== -1) score += 1;
        }
        return { ...it, _topicScore: score };
      }).filter(it => it._topicScore > 0).sort((a, b) => b._topicScore - a._topicScore);
    }
    return json(res, { items: items.slice(0, limit), count: Math.min(items.length, limit), topic: topic || null });
  });

  // POST /api/mind/insights/generate { categories?: ['repeated-question',...] }
  addRoute('POST', '/api/mind/insights/generate', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    json(res, { ok: true, started: true });
    generateInsights({ source: 'manual', categories: body.categories }).catch(() => {});
  });

  // POST /api/mind/insights/act { id }
  // Executes the insight's action payload against the appropriate mind
  // endpoint and marks the insight as acted on success.
  addRoute('POST', '/api/mind/insights/act', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    const items = insights.listInsights({ repoRoot, space, status: 'all' });
    const target = items.find(n => n.id === body.id);
    if (!target) return json(res, { error: 'insight not found' }, 404);
    let actionResult = null;
    try {
      switch (target.action.type) {
        case 'create-memory': {
          const r = await memoryModule.addMemoryCard({ repoRoot, space, spec: target.action.payload });
          actionResult = { kind: 'memory', id: r.node.id };
          notifyKnowledgeEvent({ kind: 'insight-acted-memory', nodeIds: [r.node.id], reason: 'insight-act' });
          break;
        }
        case 'create-recipe': {
          // Write a recipe stub to recipes/<slug>.json so the existing
          // recipe surfaces pick it up. The user can flesh out steps
          // later; we just save the files-to-edit hint.
          const fs = require('fs');
          const slug = (target.action.payload.slug || 'recipe').replace(/[^a-z0-9_-]/g, '-');
          const recipesDir = path.join(repoRoot, 'recipes');
          try { fs.mkdirSync(recipesDir, { recursive: true }); } catch (_) {}
          const recipePath = path.join(recipesDir, slug + '.json');
          const recipe = {
            slug,
            title: target.action.payload.title || slug,
            description: target.action.payload.description || '',
            files: target.action.payload.files || [],
            source: 'mind/insights',
            createdAt: new Date().toISOString(),
          };
          fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
          actionResult = { kind: 'recipe', path: recipePath, slug };
          break;
        }
        case 'archive-memories': {
          const ids = Array.isArray(target.action.payload.ids) ? target.action.payload.ids : [];
          const acq = lock.acquire(space, 'graph');
          if (!acq.ok) return json(res, { error: 'mind busy' }, 409);
          let archived = 0;
          try {
            const g = store.loadGraph(repoRoot, space);
            if (g) {
              for (const id of ids) {
                const idx = g.nodes.findIndex(n => n.id === id && n.kind === 'memory');
                if (idx === -1) continue;
                g.nodes[idx] = { ...g.nodes[idx], status: 'archived', archivedAt: new Date().toISOString() };
                archived++;
              }
              store.saveGraph(repoRoot, space, g);
            }
          } finally { lock.release(space, 'graph'); }
          actionResult = { kind: 'archive', archivedCount: archived };
          break;
        }
        case 'supersede-memory': {
          // Archive the older card of each pair and link newer -> older with a
          // derived_from edge, so recall stops returning the superseded card
          // but history is preserved (reversible: unset status to restore).
          const pairs = Array.isArray(target.action.payload.pairs) ? target.action.payload.pairs : [];
          const acq = lock.acquire(space, 'graph');
          if (!acq.ok) return json(res, { error: 'mind busy' }, 409);
          let superseded = 0;
          try {
            const g = store.loadGraph(repoRoot, space);
            if (g) {
              if (!Array.isArray(g.edges)) g.edges = [];
              for (const p of pairs) {
                if (!p || !p.older) continue;
                const idx = g.nodes.findIndex(n => n.id === p.older && n.kind === 'memory');
                if (idx === -1) continue;
                g.nodes[idx] = { ...g.nodes[idx], status: 'archived', archivedAt: new Date().toISOString(), supersededBy: p.newer || null };
                if (p.newer) {
                  const exists = g.edges.some(e => e.source === p.newer && e.target === p.older && e.relation === 'derived_from');
                  if (!exists) g.edges.push({ source: p.newer, target: p.older, relation: 'derived_from', confidence: 'INFERRED', confidenceScore: 0.6, weight: 1, createdBy: 'mind/supersede', createdAt: new Date().toISOString() });
                }
                superseded++;
              }
              store.saveGraph(repoRoot, space, g);
            }
          } finally { lock.release(space, 'graph'); }
          actionResult = { kind: 'supersede', superseded };
          break;
        }
        case 'extract-shared': {
          // Persist a note describing the suggestion; the user works
          // through extraction at their own pace.
          const fs = require('fs');
          const notesDir = path.join(repoRoot, 'notes', getSpace());
          try { fs.mkdirSync(notesDir, { recursive: true }); } catch (_) {}
          const ts = Date.now();
          const fname = `extract-shared-${ts}.md`;
          const noteBody = [
            `# ${target.action.payload.noteTitle || 'Extract shared'}`,
            '',
            target.action.payload.noteBody || '',
            '',
            'Repos:',
            ...(target.action.payload.repos || []).map(r => `  - ${r}`),
          ].join('\n');
          fs.writeFileSync(path.join(notesDir, fname), noteBody);
          actionResult = { kind: 'note', file: fname };
          break;
        }
        default:
          return json(res, { error: 'unknown action type: ' + target.action.type }, 400);
      }
      const updated = await insights.markActed({ repoRoot, space, id: body.id, result: actionResult });
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'insight-acted', id: body.id, actionResult } });
      return json(res, { ok: true, insight: updated, actionResult });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  });

  addRoute('POST', '/api/mind/insights/dismiss', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    try {
      const updated = await insights.dismissInsight({ repoRoot, space, id: body.id });
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'insight-dismissed', id: body.id } });
      return json(res, { ok: true, insight: updated });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, e.code === 'MIND_LOCKED' ? 409 : 500);
    }
  });

  addRoute('POST', '/api/mind/insights/snooze', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.id) return json(res, { error: 'id required' }, 400);
    const space = getSpace();
    try {
      const updated = await insights.snoozeInsight({ repoRoot, space, id: body.id, durationMs: body.durationMs });
      if (broadcast) broadcast({ type: 'mind-update', payload: { kind: 'insight-snoozed', id: body.id, snoozedUntil: updated.snoozedUntil } });
      return json(res, { ok: true, insight: updated });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, e.code === 'MIND_LOCKED' ? 409 : 500);
    }
  });
}

module.exports = { register };
