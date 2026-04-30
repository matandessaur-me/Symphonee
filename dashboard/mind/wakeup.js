/**
 * Layered wake-up — what an AI sees about the brain before it asks anything.
 *
 *   L0 (~100 tokens, always cheap)  — repo identity. activeRepo + activeRepoPath
 *                                     + CLAUDE.md/AGENTS.md preamble if present.
 *   L1 (~400-700 tokens, default)   — god nodes + recent conversation/QA nodes.
 *                                     This is the "essential story" tier.
 *   L2 / L3                          — served by /api/mind/query as before
 *                                     (wing/room filters, deep semantic search).
 *
 * Inspired by mempalace/layers.py. Two design departures from MemPalace:
 *
 *   1. We compute on demand from the in-memory graph each call. The graph is
 *      already cached by store.loadGraph; recomputing the wake-up is cheap
 *      (O(N) over nodes, no I/O beyond the optional CLAUDE.md read) and means
 *      we never serve stale wake-up text after a rebuild.
 *   2. No identity.txt — Symphonee's "identity" is the active repo + the
 *      project's CLAUDE.md. The user already maintains that file; expecting
 *      them to maintain a second one is friction.
 *
 * Output is plain text the caller can inject into a system-prompt or tack
 * onto the orchestrator's hint prefix.
 */

const fs = require('fs');
const path = require('path');
const { bestSeeds } = require('./query');

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_BUDGET_TOKENS = 900;

const CHARS_PER_GOD = 90;
const CHARS_PER_RECENT = 140;

// L0 -----------------------------------------------------------------------

function readFirstExisting(paths, max = 600) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const raw = fs.readFileSync(p, 'utf8');
        return raw.slice(0, max);
      }
    } catch (_) { /* unreadable - try next */ }
  }
  return '';
}

// Symphonee regenerates per-CLI instruction files from one template
// (INSTRUCTIONS.base.md): CLAUDE.md, AGENTS.md, GEMINI.md, GROK.md, QWEN.md,
// .github/copilot-instructions.md, .cursorrules, .windsurfrules. Each
// starts with "# <FILENAME>.md - <repo>" because writePluginHints does
// {{FILENAME}} substitution. That header is a regen artefact, not content —
// strip it so the wake-up never claims to be reading any one CLI's file
// when in reality the body is identical across all of them. A user who
// only runs Codex (no CLAUDE.md installed) gets exactly the same preamble
// from AGENTS.md.
const REGEN_HEADER = /^\s*#\s*(?:CLAUDE|AGENTS|GEMINI|GROK|QWEN|copilot-instructions|cursorrules|windsurfrules)\.md\b[^\n]*\n*/i;

function stripRegenHeader(text) {
  if (!text) return text;
  return text.replace(REGEN_HEADER, '').replace(/\{\{\s*FILENAME\s*\}\}/g, '').trim();
}

function renderL0({ activeRepo, activeRepoPath, space }) {
  const lines = ['## L0 - IDENTITY'];
  lines.push(`active_repo: ${activeRepo || '(none selected)'}`);
  if (activeRepoPath) lines.push(`active_repo_path: ${activeRepoPath}`);
  lines.push(`mind_space: ${space || '_global'}`);

  if (activeRepoPath) {
    // Try AI-instruction files in alphabetical order so no single CLI is
    // implicitly favoured. INSTRUCTIONS.base.md is the source-of-truth
    // template - if it exists, prefer it because the others are
    // regenerated copies of it. When all are present the body is identical
    // anyway, so the choice is cosmetic. A user who runs only ONE CLI
    // (just Codex / just Copilot / just Cursor) gets the same preamble
    // because every supported convention file is a candidate.
    const preamble = readFirstExisting([
      path.join(activeRepoPath, 'INSTRUCTIONS.base.md'),
      path.join(activeRepoPath, 'AGENTS.md'),
      path.join(activeRepoPath, 'CLAUDE.md'),
      path.join(activeRepoPath, 'GEMINI.md'),
      path.join(activeRepoPath, 'GROK.md'),
      path.join(activeRepoPath, 'QWEN.md'),
      path.join(activeRepoPath, '.github', 'copilot-instructions.md'),
      path.join(activeRepoPath, 'COPILOT.md'),
      path.join(activeRepoPath, '.cursorrules'),
      path.join(activeRepoPath, '.windsurfrules'),
      path.join(activeRepoPath, '.rules'),
      path.join(activeRepoPath, 'README.md'),
    ], 800);
    if (preamble) {
      const cleaned = stripRegenHeader(preamble);
      // Take the first body paragraphs after the regen-header strip.
      const paras = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      const intro = paras.slice(0, 2).join('\n\n').slice(0, 400);
      if (intro) {
        lines.push('');
        lines.push('repo_preamble:');
        for (const ln of intro.split('\n').slice(0, 8)) lines.push(`  ${ln}`);
      }
    }
  }
  return lines.join('\n');
}

// L1 -----------------------------------------------------------------------

function renderL1(graph, { maxChars, question = '' } = {}) {
  if (!graph || !graph.nodes || !graph.nodes.length) return '## L1 - No memories yet (graph empty).';

  // Query-aware mode: when a non-empty `question` is given, L1 is the
  // BFS sub-graph seeded by that question instead of generic god nodes.
  // The worker prompt prefix shifts from "here's the brain in general"
  // to "here's the brain about THIS task" — same token budget, much
  // higher signal. Pass-through `question = ''` for the default
  // generic wake-up.
  if (question && typeof question === 'string' && question.trim()) {
    return renderL1QueryAware(graph, { maxChars, question });
  }

  const lines = ['## L1 - ESSENTIAL STORY'];
  let used = lines[0].length;
  const budget = maxChars - used;

  const gods = (graph.gods || []).slice(0, 8);
  if (gods.length) {
    lines.push('');
    lines.push('gods (highest-degree nodes):');
    used += 'gods (highest-degree nodes):\n'.length;
    for (const g of gods) {
      const labelText = g.label || g.id;
      const line = `  - [${g.degree || 0}] ${labelText.slice(0, 80)}`;
      if (used + line.length > maxChars * 0.55) break;
      lines.push(line);
      used += line.length + 1;
    }
  }

  const recent = graph.nodes
    .filter(n => n.kind === 'conversation' && n.createdAt)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 8);
  if (recent.length) {
    lines.push('');
    lines.push('recent_conversations:');
    used += 'recent_conversations:\n'.length;
    for (const n of recent) {
      const when = (n.createdAt || '').slice(0, 10);
      const labelText = (n.label || n.id).slice(0, 80);
      const line = `  - ${when} [${n.createdBy || '?'}] ${labelText}`;
      if (used + line.length > budget) {
        lines.push('  ...');
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }

  return lines.join('\n');
}

function renderL1QueryAware(graph, { maxChars, question }) {
  const seeds = bestSeeds(graph, question, 5);
  if (!seeds.length) {
    // Question doesn't hit the corpus — degrade to generic L1.
    return renderL1(graph, { maxChars });
  }
  const lines = [`## L1 - TASK CONTEXT for "${question.slice(0, 100)}"`];
  let used = lines[0].length;

  // 1-hop expansion from seeds: each seed plus its top-3 most-confident
  // neighbours, ranked EXTRACTED > INFERRED > AMBIGUOUS.
  const adj = new Map();
  for (const e of (graph.edges || [])) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push({ peer: e.target, edge: e });
    adj.get(e.target).push({ peer: e.source, edge: e });
  }
  const confRank = (e) => e.confidence === 'EXTRACTED' ? 0 : e.confidence === 'INFERRED' ? 1 : 2;
  const seen = new Set();

  for (const seedId of seeds) {
    const seed = graph.nodes.find(n => n.id === seedId);
    if (!seed) continue;
    if (used + 200 > maxChars) break;
    if (seen.has(seedId)) continue;
    seen.add(seedId);

    const seedLine = `\n[${seed.kind}] ${(seed.label || seedId).slice(0, 100)}`;
    lines.push(seedLine);
    used += seedLine.length + 1;

    const neighbours = (adj.get(seedId) || [])
      .sort((a, b) => confRank(a.edge) - confRank(b.edge))
      .slice(0, 3);
    for (const { peer, edge } of neighbours) {
      if (seen.has(peer)) continue;
      seen.add(peer);
      const peerNode = graph.nodes.find(n => n.id === peer);
      if (!peerNode) continue;
      const sym = edge.confidence === 'EXTRACTED' ? '->' : edge.confidence === 'INFERRED' ? '~>' : '?>';
      const line = `  ${sym} (${edge.relation}) [${peerNode.kind}] ${(peerNode.label || peer).slice(0, 80)}`;
      if (used + line.length > maxChars) {
        lines.push('  ... (more in /api/mind/query)');
        return lines.join('\n');
      }
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines.join('\n');
}

// Composition --------------------------------------------------------------

function composeWakeUp(graph, { activeRepo, activeRepoPath, space, budgetTokens = DEFAULT_BUDGET_TOKENS, question = '' } = {}) {
  const budgetChars = Math.max(200, budgetTokens * APPROX_CHARS_PER_TOKEN);
  const l0 = renderL0({ activeRepo, activeRepoPath, space });
  const l0Chars = l0.length + 2;
  const l1Budget = Math.max(300, budgetChars - l0Chars);
  const l1 = renderL1(graph, { maxChars: l1Budget, question });
  const text = `${l0}\n\n${l1}`;
  return {
    text,
    estTokens: Math.round(text.length / APPROX_CHARS_PER_TOKEN),
    layers: { l0Chars: l0.length, l1Chars: l1.length },
    queryAware: !!(question && question.trim()),
  };
}

module.exports = {
  composeWakeUp,
  renderL0,
  renderL1,
  DEFAULT_BUDGET_TOKENS,
  APPROX_CHARS_PER_TOKEN,
  CHARS_PER_GOD,
  CHARS_PER_RECENT,
};
