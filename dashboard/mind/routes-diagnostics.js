'use strict';
// Mind diagnostics: CLI routing suggestion, graph visualisation, per-CLI coverage.

const store = require('./store');
const query = require('./query');
const viz = require('./viz');

function register(addRoute, json, deps) {
  const { repoRoot, getSpace, getUiContext, readBody, ctx } = deps;

  addRoute('POST', '/api/mind/suggest-cli', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const { question, prompt, limit = 5 } = body;
    const q = question || prompt;
    if (!q) return json(res, { error: 'question or prompt required' }, 400);
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { suggestions: [], note: 'graph empty' });

    const seedIds = query.bestSeeds(g, q, 20);
    if (!seedIds.length) return json(res, { suggestions: [], note: 'no similar tasks in brain yet' });

    // Among seeded nodes, look for conversation/qa/task nodes carrying a CLI.
    const now = Date.now();
    const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const perCli = new Map();
    for (const sid of seedIds) {
      const n = g.nodes.find(x => x.id === sid);
      if (!n) continue;
      if (n.kind !== 'conversation' && n.kind !== 'drawer') continue;
      const cli = n.createdBy;
      if (!cli || cli === 'system' || cli === 'orchestrator' || cli === 'unknown') continue;
      const age = n.createdAt ? Math.max(0, now - new Date(n.createdAt).getTime()) : halfLifeMs;
      const recencyScore = Math.exp(-age / halfLifeMs);
      const slot = perCli.get(cli) || { cli, count: 0, score: 0, latest: null, examples: [] };
      slot.count += 1;
      slot.score += recencyScore;
      if (!slot.latest || (n.createdAt && n.createdAt > slot.latest)) slot.latest = n.createdAt || slot.latest;
      if (slot.examples.length < 3) slot.examples.push({ id: n.id, label: (n.label || '').slice(0, 80), createdAt: n.createdAt });
      perCli.set(cli, slot);
    }
    const suggestions = Array.from(perCli.values()).sort((a, b) => b.score - a.score).slice(0, limit);
    return json(res, {
      question: q.slice(0, 200),
      suggestions,
      note: suggestions.length ? 'advisory only; model-router still authoritative for intent-based picks' : 'no past CLI activity for similar tasks',
    });
  });

  // ── Visualisation (mermaid text + interactive HTML viewer) ──────────────
  addRoute('POST', '/api/mind/visualize', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const space = getSpace();
    const g = store.loadGraph(repoRoot, space);
    if (!g) return json(res, { error: 'graph empty' }, 404);
    const mode = (body.mode || 'mermaid').toLowerCase();
    if (mode === 'mermaid') {
      return json(res, { mode, mermaid: viz.mermaidGraph(g, { focus: body.focus || null, max: body.max || 200 }) });
    }
    if (mode === 'interactive') {
      const opts = { focus: body.focus || null, layout: body.layout || 'cose', title: `Mind: ${space}` };
      if (body.inline) {
        const html = viz.interactiveHtml(g, opts);
        return json(res, { mode, html, openIn: 'inline' });
      }
      const out = viz.writeInteractive(g, opts);
      return json(res, { mode, ...out, openIn: 'webview' });
    }
    return json(res, { error: 'mode must be mermaid or interactive' }, 400);
  });

  // ── CLI coverage diagnostic ─────────────────────────────────────────────
  // Symphonee is a multi-CLI system - this endpoint shows per-CLI evidence
  // in the brain so the user can verify nothing's silently missing. For
  // each known CLI, returns: memory file presence (in active repo),
  // node count by tag, recent conversation count, history nodes, drawer
  // nodes. If a CLI has zero coverage that's a real signal something is
  // wrong (extractor bug, missing convention, etc), not a quirk.
  addRoute('GET', '/api/mind/cli-coverage', (req, res) => {
    const space = getSpace();
    const ui = getUiContext ? getUiContext() : {};
    const fs = require('fs');
    const path = require('path');
    const allRepos = (typeof ctx.getAllRepos === 'function' ? (ctx.getAllRepos() || {}) : {});
    const reposToCheck = Object.entries(allRepos).length ? Object.entries(allRepos) : [[ui.activeRepo || '_active', ui.activeRepoPath]];

    const KNOWN = ['claude', 'codex', 'gemini', 'grok', 'qwen', 'copilot', 'cursor', 'windsurf'];
    const { CLI_MEMORY_FILES } = require('./extractors/cli-memory');
    const memoryConventions = Object.fromEntries(CLI_MEMORY_FILES.map(e => [e.cli, e.paths]));

    const g = store.loadGraph(repoRoot, space);
    const nodes = (g && g.nodes) || [];
    const counts = {};
    for (const cli of KNOWN) counts[cli] = { memoryFiles: 0, conversations: 0, drawers: 0, history: 0, skills: 0, plugins: 0 };

    for (const n of nodes) {
      // memory nodes are id-prefixed climem_<cli>
      if (typeof n.id === 'string' && n.id.startsWith('climem_')) {
        const cli = n.id.replace('climem_', '');
        if (counts[cli]) counts[cli].memoryFiles += 1;
      }
      const cb = n.createdBy || '';
      if (n.kind === 'conversation' && KNOWN.includes(cb)) counts[cb].conversations += 1;
      if (n.kind === 'drawer' && KNOWN.includes(cb)) counts[cb].drawers += 1;
      if (n.source && n.source.type === 'cli-history' && KNOWN.includes(n.source.cli)) counts[n.source.cli].history += 1;
      // skills, agents, plugins are tagged via createdBy 'mind/cli-skills' but
      // each node has tags like cli:claude / cli:codex
      if (Array.isArray(n.tags)) {
        for (const t of n.tags) {
          for (const cli of KNOWN) {
            if (t === 'cli:' + cli || t === cli) {
              if (n.kind === 'plugin') counts[cli].plugins += 1;
              else if (n.kind === 'recipe' || n.kind === 'concept' || n.kind === 'doc') {
                if (Array.isArray(n.tags) && (n.tags.includes('skill') || n.tags.includes('agent'))) {
                  counts[cli].skills += 1;
                }
              }
            }
          }
        }
      }
    }

    // Per-repo memory file presence
    const memoryFilesByRepo = {};
    for (const [repoName, p] of reposToCheck) {
      if (!p) continue;
      memoryFilesByRepo[repoName] = {};
      for (const cli of KNOWN) {
        const candidates = memoryConventions[cli] || [];
        const found = candidates.find(rel => fs.existsSync(path.join(p, rel)));
        memoryFilesByRepo[repoName][cli] = found || null;
      }
    }

    return json(res, {
      space,
      cliKnown: KNOWN,
      counts,
      memoryConventions,
      memoryFilesByRepo,
      note: 'Symphonee is multi-CLI. Every supported CLI ingests symmetrically. A CLI with zero memory file in this repo simply means the file does not exist there, NOT that the CLI is unsupported.',
    });
  });
}

module.exports = { register };
