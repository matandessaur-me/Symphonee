/**
 * Learnings extractor: every learning becomes a node. Edges:
 *   learning --tagged_with--> category
 *   learning --tagged_with--> cli (when present)
 *
 * This makes the curated mistakes table queryable through the same graph
 * surface. An agent asking "what do we know about codex headless flags"
 * will walk this sub-graph instead of skimming the raw list.
 */

const { sanitizeLabel } = require('../security');
const { makeIdFromLabel } = require('../ids');

function extractLearnings({ getLearnings, createdBy = 'mind/learnings' }) {
  const all = (getLearnings && getLearnings() && getLearnings().list && getLearnings().list()) || [];
  const nodes = [];
  const edges = [];
  const seenCategory = new Set();
  const seenCli = new Set();

  for (const l of all) {
    const id = `learning_${l.id || makeIdFromLabel(l.summary || 'unknown')}`;
    nodes.push({
      id, label: sanitizeLabel((l.summary || '(empty)').slice(0, 200)),
      kind: 'concept',
      source: { type: 'learning', ref: l.id, addedAt: l.addedAt },
      sourceLocation: null,
      createdBy: l.cli || createdBy,
      createdAt: new Date(l.addedAt || Date.now()).toISOString(),
      tags: [l.category, l.cli].filter(Boolean),
      detail: l.detail || null,
    });

    if (l.category) {
      const cid = `category_${l.category}`;
      if (!seenCategory.has(cid)) {
        nodes.push({
          id: cid, label: sanitizeLabel(`#${l.category}`), kind: 'tag',
          source: { type: 'category', ref: l.category }, sourceLocation: null,
          createdBy, createdAt: new Date().toISOString(), tags: [],
        });
        seenCategory.add(cid);
      }
      edges.push({
        source: id, target: cid, relation: 'tagged_with',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }

    if (l.cli) {
      const cliId = `cli_${l.cli}`;
      if (!seenCli.has(cliId)) {
        nodes.push({
          id: cliId, label: sanitizeLabel(l.cli), kind: 'tag',
          source: { type: 'cli', ref: l.cli }, sourceLocation: null,
          createdBy, createdAt: new Date().toISOString(), tags: [],
        });
        seenCli.add(cliId);
      }
      edges.push({
        source: id, target: cliId, relation: 'tagged_with',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }
  }

  return { nodes, edges, scanned: all.length };
}

module.exports = { extractLearnings };
