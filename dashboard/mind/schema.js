/**
 * Mind canonical schema.
 *
 * Every node and edge in Symphonee Mind conforms to the shapes below.
 * Plugins, extractors, and the query layer all read and write through these
 * validators, so the graph file on disk is always self-describing.
 *
 * Confidence labels are non-negotiable: an agent reading the graph must be
 * able to tell EXTRACTED (explicit in source) from INFERRED (defensible
 * deduction) from AMBIGUOUS (uncertain, never silently dropped).
 */

const SCHEMA_VERSION = 1;

const NODE_KINDS = new Set([
  'note', 'code', 'doc', 'paper', 'image', 'workitem',
  'recipe', 'conversation', 'plugin', 'concept', 'tag',
]);

const CONFIDENCE_LABELS = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);

const RELATIONS = new Set([
  // structural
  'imports', 'calls', 'defines', 'contains', 'extends', 'implements',
  // documentary
  'describes', 'cites', 'references', 'links_to',
  // semantic
  'conceptually_related_to', 'semantically_similar_to', 'participate_in',
  // derivative
  'derived_from', 'answers',
  // tags
  'tagged_with',
]);

function emptyGraph(scope) {
  return {
    version: SCHEMA_VERSION,
    scope: { space: scope.space || null, isGlobal: !!scope.isGlobal },
    generatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
    hyperedges: [],
    communities: {},
    gods: [],
    surprises: [],
    stats: { nodes: 0, edges: 0, communities: 0, tokenCost: 0 },
  };
}

function validateNode(n) {
  if (!n || typeof n !== 'object') return 'node not an object';
  if (typeof n.id !== 'string' || !n.id) return 'node.id missing';
  if (typeof n.label !== 'string' || !n.label) return `node ${n.id}: label missing`;
  if (!NODE_KINDS.has(n.kind)) return `node ${n.id}: unknown kind ${n.kind}`;
  if (n.source && typeof n.source !== 'object') return `node ${n.id}: source must be object`;
  return null;
}

function validateEdge(e, nodeIds) {
  if (!e || typeof e !== 'object') return 'edge not an object';
  if (typeof e.source !== 'string') return 'edge.source missing';
  if (typeof e.target !== 'string') return 'edge.target missing';
  if (!RELATIONS.has(e.relation)) return `edge ${e.source}->${e.target}: unknown relation ${e.relation}`;
  if (!CONFIDENCE_LABELS.has(e.confidence)) return `edge ${e.source}->${e.target}: bad confidence ${e.confidence}`;
  if (typeof e.confidenceScore !== 'number' || e.confidenceScore < 0 || e.confidenceScore > 1) {
    return `edge ${e.source}->${e.target}: confidenceScore out of range`;
  }
  if (nodeIds && (!nodeIds.has(e.source) || !nodeIds.has(e.target))) {
    return null; // dangling edges allowed during merge; build pass filters them
  }
  return null;
}

function validateGraph(g) {
  const errors = [];
  if (!g || typeof g !== 'object') return ['graph not an object'];
  if (g.version !== SCHEMA_VERSION) errors.push(`unsupported version ${g.version}`);
  if (!Array.isArray(g.nodes)) errors.push('nodes not an array');
  if (!Array.isArray(g.edges)) errors.push('edges not an array');
  if (errors.length) return errors;
  const ids = new Set();
  for (const n of g.nodes) {
    const e = validateNode(n);
    if (e) errors.push(e);
    else if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    else ids.add(n.id);
  }
  for (const e of g.edges) {
    const err = validateEdge(e, ids);
    if (err) errors.push(err);
  }
  return errors;
}

function makeNode({ id, label, kind, source, sourceLocation, createdBy, tags, extra }) {
  return {
    id, label, kind,
    source: source || null,
    sourceLocation: sourceLocation || null,
    createdBy: createdBy || 'system',
    createdAt: new Date().toISOString(),
    tags: Array.isArray(tags) ? tags : [],
    ...(extra || {}),
  };
}

function makeEdge({ source, target, relation, confidence, confidenceScore, weight, createdBy, extra }) {
  return {
    source, target, relation,
    confidence: confidence || 'INFERRED',
    confidenceScore: typeof confidenceScore === 'number' ? confidenceScore : 0.5,
    weight: typeof weight === 'number' ? weight : 1.0,
    createdBy: createdBy || 'system',
    createdAt: new Date().toISOString(),
    ...(extra || {}),
  };
}

module.exports = {
  SCHEMA_VERSION,
  NODE_KINDS,
  CONFIDENCE_LABELS,
  RELATIONS,
  emptyGraph,
  validateNode,
  validateEdge,
  validateGraph,
  makeNode,
  makeEdge,
};
