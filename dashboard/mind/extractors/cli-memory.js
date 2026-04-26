/**
 * CLI memory extractor.
 *
 * Each AI CLI ships with its own per-repo memory file at the project root.
 * In Symphonee these are CLAUDE.md, AGENTS.md, GEMINI.md, GROK.md, QWEN.md,
 * INSTRUCTIONS.base.md - they are typically near-identical so all CLIs
 * receive the same orientation.
 *
 * We treat each as a markdown source. Wikilinks/markdown links inside become
 * edges into the graph (e.g. CLAUDE.md links to scripts/Show-Diff.ps1 -> the
 * script becomes a downstream node, even before any code extraction has run).
 */

const fs = require('fs');
const path = require('path');
const { extractMarkdown } = require('./markdown');
const { makeIdFromLabel } = require('../ids');

const CLI_MEMORY_FILES = [
  { file: 'CLAUDE.md', cli: 'claude' },
  { file: 'AGENTS.md', cli: 'codex' },
  { file: 'GEMINI.md', cli: 'gemini' },
  { file: 'GROK.md', cli: 'grok' },
  { file: 'QWEN.md', cli: 'qwen' },
  { file: 'COPILOT.md', cli: 'copilot' },
  { file: 'INSTRUCTIONS.base.md', cli: '_shared' },
];

function extractCliMemory({ repoRoot, createdBy = 'mind/cli-memory' }) {
  const fragments = [];
  let scanned = 0;
  for (const { file, cli } of CLI_MEMORY_FILES) {
    const full = path.join(repoRoot, file);
    if (!fs.existsSync(full)) continue;
    let body;
    try { body = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
    scanned++;
    const id = `climem_${cli}`;
    const frag = extractMarkdown({
      id,
      label: `${cli} memory (${file})`,
      kind: 'doc',
      source: { type: 'cli-memory', ref: file, cli, file: full },
      body,
      createdBy,
      tagPrefix: 'doc',
    });

    // Add an edge from the CLI tag to the memory node so all per-CLI memory
    // is discoverable through one community.
    const cliTagId = `cli_${cli}`;
    frag.nodes.push({
      id: cliTagId, label: cli, kind: 'tag',
      source: { type: 'cli', ref: cli }, sourceLocation: null,
      createdBy, createdAt: new Date().toISOString(), tags: [],
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
  return { nodes, edges, scanned };
}

module.exports = { extractCliMemory, CLI_MEMORY_FILES };
