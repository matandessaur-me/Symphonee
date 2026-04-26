/**
 * Instructions extractor. Walks dashboard/instructions/*.md (the core shell
 * docs every CLI fetches at bootstrap) and turns each into a doc node with
 * heading-level concept nodes underneath. Cross-references between them
 * (e.g. orchestrator.md mentioning permissions.md) become edges.
 */

const fs = require('fs');
const path = require('path');
const { extractMarkdown } = require('./markdown');
const { makeIdFromLabel } = require('../ids');

function extractInstructions({ repoRoot, createdBy = 'mind/instructions' }) {
  const dir = path.join(repoRoot, 'dashboard', 'instructions');
  const fragments = [];
  let scanned = 0;
  if (!fs.existsSync(dir)) return { nodes: [], edges: [], scanned: 0 };
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
    const full = path.join(dir, f);
    let body; try { body = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
    scanned++;
    const stem = f.replace(/\.md$/i, '');
    const id = `instr_${makeIdFromLabel(stem)}`;
    fragments.push(extractMarkdown({
      id,
      label: `instructions/${stem}`,
      kind: 'doc',
      source: { type: 'instructions', ref: stem, file: full },
      body,
      createdBy,
      tagPrefix: 'doc',
    }));
  }
  const nodes = []; const edges = [];
  for (const fr of fragments) { nodes.push(...fr.nodes); edges.push(...fr.edges); }
  return { nodes, edges, scanned };
}

module.exports = { extractInstructions };
