/**
 * Phase D enrichment extractor: promote every connected repository to a
 * first-class node.
 *
 * The legacy build emits one `kind:tag` node per repo (id `cwd_<slug>`,
 * label `@<repoName>`) and points every member at it via `in_repo` edges.
 * That tag is good for filtering but not for traversal: BFS treats it as
 * just another tag among many, the visualization renders it small, and
 * cross-repo queries can't pivot on it.
 *
 * This extractor reads the merged graph after every other source has run
 * and synthesizes a parallel `kind:repo` node for each unique cwd_* tag,
 * with `member_of` edges from every node tagged in that repo. Both layers
 * coexist - nothing in the legacy graph changes - so we gain repo-level
 * intelligence without touching anything that already works.
 *
 * Pure function. No disk reads. Idempotent: rerunning over the same graph
 * produces the same fragment.
 */

'use strict';

function extractRepos({ nodes = [], edges = [] } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) {
    return { nodes: [], edges: [], scanned: 0, repos: 0 };
  }

  // Find every cwd_* tag and remember its label (with @ prefix preserved).
  const cwdTags = new Map(); // tagId -> label
  for (const n of nodes) {
    if (n && n.kind === 'tag' && typeof n.id === 'string' && n.id.startsWith('cwd_')) {
      cwdTags.set(n.id, n.label || n.id);
    }
  }
  if (!cwdTags.size) return { nodes: [], edges: [], scanned: 0, repos: 0 };

  // Find members. The legacy in_repo edge points member -> tag.
  const membersByTag = new Map();
  for (const tagId of cwdTags.keys()) membersByTag.set(tagId, []);
  for (const e of edges) {
    if (!e || e.relation !== 'in_repo') continue;
    const list = membersByTag.get(e.target);
    if (list) list.push(e.source);
  }

  const newNodes = [];
  const newEdges = [];
  const createdAt = new Date().toISOString();

  for (const [tagId, tagLabel] of cwdTags.entries()) {
    const slug = tagId.replace(/^cwd_/, '');
    const repoId = `repo_node_${slug}`;
    // Display label drops the leading "@" so the repo node is visually
    // distinct from the tag.
    const cleanLabel = String(tagLabel || slug).replace(/^@+/, '');
    newNodes.push({
      id: repoId,
      label: cleanLabel,
      kind: 'repo',
      source: { type: 'repo-enrichment', ref: slug },
      tags: ['repo'],
      createdBy: 'mind/repos',
      createdAt,
    });
    // Pivot edge: existing tag <-> new repo node. Lets BFS hop from the
    // (still-present) tag world into the new repo world without anyone
    // having to know about the tag.
    newEdges.push({
      source: tagId,
      target: repoId,
      relation: 'tagged_with',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      weight: 1,
      createdBy: 'mind/repos',
      createdAt,
    });
    for (const memberId of membersByTag.get(tagId) || []) {
      newEdges.push({
        source: memberId,
        target: repoId,
        relation: 'member_of',
        confidence: 'EXTRACTED',
        confidenceScore: 1,
        weight: 1,
        createdBy: 'mind/repos',
        createdAt,
      });
    }
  }

  return {
    nodes: newNodes,
    edges: newEdges,
    scanned: cwdTags.size,
    repos: cwdTags.size,
  };
}

module.exports = { extractRepos };
