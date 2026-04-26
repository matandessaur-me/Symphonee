/**
 * Topology-only community detection. No embeddings, no vector store - the
 * graph structure IS the similarity signal.
 *
 * Phase 1 uses a self-contained Louvain implementation so we can ship without
 * an npm install. The interface matches what graphology-communities-louvain
 * exposes, so swapping is mechanical when we're ready to take the dep.
 *
 * Oversized communities (any community > 25% of total nodes, min 10) get a
 * second pass to split them. Lifted from graphify/cluster.py - free quality.
 */

const MAX_COMMUNITY_FRACTION = 0.25;
const MIN_SPLIT_SIZE = 10;
const ITERATIONS = 20;

function buildAdjacency(nodes, edges) {
  const adj = new Map(); // id -> Map(neighbor -> weight sum, undirected)
  for (const n of nodes) adj.set(n.id, new Map());
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    const w = typeof e.weight === 'number' ? e.weight : 1;
    if (e.source === e.target) continue;
    const a = adj.get(e.source);
    const b = adj.get(e.target);
    a.set(e.target, (a.get(e.target) || 0) + w);
    b.set(e.source, (b.get(e.source) || 0) + w);
  }
  return adj;
}

function nodeStrength(adj, id) {
  let s = 0;
  for (const [, w] of adj.get(id)) s += w;
  return s;
}

function totalWeight(adj) {
  let m = 0;
  for (const [id] of adj) m += nodeStrength(adj, id);
  return m / 2;
}

/**
 * Single-level Louvain: assign each node to the neighboring community whose
 * inclusion gives the largest modularity gain. Repeat until no node moves.
 *
 * This is the classical Blondel-Guillaume-Lambiotte-Lefebvre algorithm,
 * stripped to the core (no aggregation pass; we run multiple passes from
 * scratch and split oversized communities afterward instead).
 */
function louvainPass(adj, seedCommunities) {
  const community = new Map();
  if (seedCommunities) {
    for (const [id, cid] of seedCommunities) community.set(id, cid);
  } else {
    let i = 0;
    for (const id of adj.keys()) community.set(id, i++);
  }
  const m2 = totalWeight(adj) * 2 || 1;
  const communityWeight = new Map();
  for (const [id, c] of community) {
    communityWeight.set(c, (communityWeight.get(c) || 0) + nodeStrength(adj, id));
  }

  let moved = true;
  let iter = 0;
  while (moved && iter < ITERATIONS) {
    moved = false;
    iter++;
    for (const id of adj.keys()) {
      const myComm = community.get(id);
      const myStrength = nodeStrength(adj, id);
      // Sum of weights from id to each neighbor community.
      const neighborComms = new Map();
      for (const [n, w] of adj.get(id)) {
        const nc = community.get(n);
        neighborComms.set(nc, (neighborComms.get(nc) || 0) + w);
      }
      // Remove id from myComm
      communityWeight.set(myComm, (communityWeight.get(myComm) || 0) - myStrength);
      let bestComm = myComm;
      let bestGain = 0;
      for (const [c, ki_in] of neighborComms) {
        const sumTot = communityWeight.get(c) || 0;
        const gain = ki_in / m2 - (sumTot * myStrength) / (m2 * m2 / 2);
        if (gain > bestGain + 1e-9) { bestGain = gain; bestComm = c; }
      }
      community.set(id, bestComm);
      communityWeight.set(bestComm, (communityWeight.get(bestComm) || 0) + myStrength);
      if (bestComm !== myComm) moved = true;
    }
  }
  return community;
}

function splitOversized(adj, communityMap, totalNodes) {
  const maxSize = Math.max(MIN_SPLIT_SIZE, Math.floor(totalNodes * MAX_COMMUNITY_FRACTION));
  const groups = new Map();
  for (const [id, c] of communityMap) {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(id);
  }
  const finalGroups = [];
  for (const [, members] of groups) {
    if (members.length <= maxSize) { finalGroups.push(members); continue; }
    // Run a sub-Louvain on the induced subgraph
    const subAdj = new Map();
    const memberSet = new Set(members);
    for (const id of members) subAdj.set(id, new Map());
    for (const id of members) {
      for (const [n, w] of adj.get(id)) {
        if (memberSet.has(n)) subAdj.get(id).set(n, w);
      }
    }
    const subComms = louvainPass(subAdj);
    const subGroups = new Map();
    for (const [id, c] of subComms) {
      if (!subGroups.has(c)) subGroups.set(c, []);
      subGroups.get(c).push(id);
    }
    if (subGroups.size <= 1) { finalGroups.push(members); continue; }
    for (const [, sg] of subGroups) finalGroups.push(sg);
  }
  // Re-index sorted by size descending so community 0 is always the largest.
  finalGroups.sort((a, b) => b.length - a.length);
  return finalGroups;
}

function cohesion(adj, members) {
  const n = members.length;
  if (n <= 1) return 1;
  const memberSet = new Set(members);
  let actual = 0;
  for (const id of members) {
    for (const [neighbor] of adj.get(id)) if (memberSet.has(neighbor)) actual++;
  }
  actual /= 2;
  const possible = (n * (n - 1)) / 2;
  return possible > 0 ? Math.round((actual / possible) * 100) / 100 : 0;
}

function cluster(graph) {
  const { nodes, edges } = graph;
  if (!nodes.length) return { communities: {}, assignments: new Map() };
  const adj = buildAdjacency(nodes, edges);
  const isolates = nodes.filter(n => adj.get(n.id).size === 0).map(n => n.id);
  const connected = new Map();
  for (const [id, m] of adj) if (m.size > 0) connected.set(id, m);
  let communityMap = new Map();
  if (connected.size > 0) communityMap = louvainPass(connected);
  // Each isolate becomes its own community
  let next = Math.max(-1, ...communityMap.values()) + 1;
  for (const id of isolates) communityMap.set(id, next++);

  const finalGroups = splitOversized(adj, communityMap, nodes.length);

  const communities = {};
  const assignments = new Map();
  finalGroups.forEach((members, idx) => {
    communities[idx] = {
      label: deriveLabel(nodes, members),
      nodeIds: members.slice().sort(),
      cohesion: cohesion(adj, members),
      size: members.length,
    };
    for (const id of members) assignments.set(id, idx);
  });

  // Tag nodes with their community.
  for (const n of nodes) n.communityId = assignments.get(n.id) ?? null;

  return { communities, assignments };
}

function deriveLabel(nodes, memberIds) {
  // Use the most-common kind + first 2 high-degree labels as a hint.
  const ids = new Set(memberIds);
  const sample = nodes.filter(n => ids.has(n.id)).slice(0, 30);
  const kindCounts = {};
  for (const n of sample) kindCounts[n.kind] = (kindCounts[n.kind] || 0) + 1;
  const topKind = Object.entries(kindCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'mixed';
  const labelHint = sample.slice(0, 2).map(n => n.label).join(' / ');
  return `${topKind}: ${labelHint || 'cluster'}`.slice(0, 80);
}

module.exports = { cluster };
