/**
 * CLI memory extractor.
 *
 * Each AI CLI has its own per-repo memory file convention. Symphonee
 * regenerates them from a single source-of-truth (INSTRUCTIONS.base.md), but
 * the file LOCATIONS differ - some CLIs read the file from the repo root,
 * others look for it in a subdirectory.
 *
 * This extractor honors every supported CLI's real convention so no agent
 * is implicitly excluded from the brain. Each CLI entry has a list of
 * candidate paths; the first one that exists wins. A CLI with no memory
 * file in this repo simply doesn't contribute - it does NOT mean the CLI
 * is unsupported.
 *
 * Wikilinks and markdown links inside each file become edges, so a memory
 * file pointing at scripts/Show-Diff.ps1 creates a node for that script
 * even before any code extraction runs.
 */

const fs = require('fs');
const path = require('path');
const { extractMarkdown } = require('./markdown');

// Per-CLI memory file conventions. Order inside `paths` is "preferred first":
// the first existing file wins. Most repos will have only one variant per CLI.
const CLI_MEMORY_FILES = [
  { cli: 'claude',   paths: ['CLAUDE.md'] },
  { cli: 'codex',    paths: ['AGENTS.md'] },
  { cli: 'gemini',   paths: ['GEMINI.md'] },
  { cli: 'grok',     paths: ['GROK.md'] },
  { cli: 'qwen',     paths: ['QWEN.md'] },
  // Copilot reads from .github/copilot-instructions.md (its documented
  // convention). Some users also create COPILOT.md at the repo root for
  // symmetry; honor both.
  { cli: 'copilot',  paths: ['.github/copilot-instructions.md', 'COPILOT.md'] },
  { cli: 'cursor',   paths: ['.cursorrules', '.cursor/rules.md'] },
  { cli: 'windsurf', paths: ['.windsurfrules'] },
  { cli: 'zed',      paths: ['.rules', '.zed/rules.md'] },
  { cli: '_shared',  paths: ['INSTRUCTIONS.base.md'] },
];

function extractCliMemory({ repoRoot, createdBy = 'mind/cli-memory' }) {
  const fragments = [];
  let scanned = 0;
  const perCli = {};

  for (const { cli, paths } of CLI_MEMORY_FILES) {
    let foundPath = null;
    let body = null;
    for (const rel of paths) {
      const full = path.join(repoRoot, rel);
      if (!fs.existsSync(full)) continue;
      try { body = fs.readFileSync(full, 'utf8'); foundPath = rel; break; }
      catch (_) { /* unreadable - try next */ }
    }
    if (body == null) { perCli[cli] = { found: false }; continue; }
    scanned++;
    perCli[cli] = { found: true, path: foundPath };

    const id = `climem_${cli}`;
    const frag = extractMarkdown({
      id,
      label: `${cli} memory (${foundPath})`,
      kind: 'doc',
      source: { type: 'cli-memory', ref: foundPath, cli, file: path.join(repoRoot, foundPath) },
      body,
      createdBy,
      tagPrefix: 'doc',
    });

    // Tag every memory node with its CLI so the graph clusters cleanly:
    // queries like "who has CLAUDE-level memory?" group through the
    // cli_<provider> tag rather than relying on filename heuristics.
    const cliTagId = `cli_${cli}`;
    frag.nodes.push({
      id: cliTagId, label: cli, kind: 'tag',
      source: { type: 'cli', ref: cli }, sourceLocation: null,
      createdBy, createdAt: new Date().toISOString(), tags: [cli],
    });
    frag.edges.push({
      source: id, target: cliTagId, relation: 'tagged_with',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: new Date().toISOString(),
    });

    fragments.push(frag);
  }

  const nodes = []; const edges = [];
  for (const fr of fragments) { nodes.push(...fr.nodes); edges.push(...fr.edges); }
  return { nodes, edges, scanned, perCli };
}

module.exports = { extractCliMemory, CLI_MEMORY_FILES };
