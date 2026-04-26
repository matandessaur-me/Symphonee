/**
 * Notes extractor: walk Symphonee's per-space notes directory and emit a
 * graph fragment. Uses the generic markdown extractor under the hood so
 * wikilinks resolve correctly across notes regardless of casing.
 */

const fs = require('fs');
const path = require('path');
const { extractMarkdown } = require('./markdown');
const { makeIdFromLabel } = require('../ids');

function _resolveNotesNs(notesRoot, ns) {
  return path.join(notesRoot, (ns || '_global').replace(/[^A-Za-z0-9_-]+/g, '_'));
}

function extractNotes({ repoRoot, notesNamespace, notesRoot, createdBy = 'mind/notes' }) {
  const baseRoot = notesRoot || path.join(repoRoot, 'notes');
  const dir = _resolveNotesNs(baseRoot, notesNamespace);
  const fragments = [];
  if (!fs.existsSync(dir)) return { nodes: [], edges: [], scanned: 0, dir };

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  for (const f of files) {
    const full = path.join(dir, f);
    let body;
    try { body = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
    const stem = f.replace(/\.md$/i, '');
    const id = makeIdFromLabel(stem, 'note');
    fragments.push(extractMarkdown({
      id,
      label: stem,
      kind: 'note',
      source: { type: 'note', ref: stem, file: full },
      body,
      createdBy,
      tagPrefix: 'note',
    }));
  }

  // Flatten
  const nodes = []; const edges = [];
  for (const fr of fragments) { nodes.push(...fr.nodes); edges.push(...fr.edges); }
  return { nodes, edges, scanned: files.length, dir };
}

module.exports = { extractNotes };
