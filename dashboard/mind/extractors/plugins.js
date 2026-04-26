/**
 * Plugins extractor. Each active plugin becomes a node; its keywords become
 * tag nodes; the plugin itself gets an edge to the active repo if its
 * activationConditions match. This is what lets the brain answer "which
 * plugin should I use for X?" by walking edges instead of pattern-matching
 * keyword lists.
 */

const { sanitizeLabel } = require('../security');
const { makeIdFromLabel } = require('../ids');

function extractPlugins({ getPlugins, getUiContext, createdBy = 'mind/plugins' }) {
  const plugins = (getPlugins && getPlugins()) || [];
  const ctx = (getUiContext && getUiContext()) || {};
  const activeRepoId = ctx.activeRepo ? `repo_${makeIdFromLabel(ctx.activeRepo)}` : null;
  const nodes = []; const edges = [];

  if (activeRepoId) {
    nodes.push({
      id: activeRepoId, label: sanitizeLabel(ctx.activeRepo), kind: 'concept',
      source: { type: 'repo', ref: ctx.activeRepo, path: ctx.activeRepoPath },
      sourceLocation: null, createdBy, createdAt: new Date().toISOString(),
      tags: ['repo'],
    });
  }

  for (const p of plugins) {
    const pid = `plugin_${p.id}`;
    nodes.push({
      id: pid, label: sanitizeLabel(p.name || p.id), kind: 'plugin',
      source: { type: 'plugin', ref: p.id },
      sourceLocation: null, createdBy, createdAt: new Date().toISOString(),
      tags: ['plugin'],
      description: p.description || null,
    });
    const keywords = p.aiKeywords || p.keywords || [];
    for (const kw of keywords) {
      const tid = `keyword_${makeIdFromLabel(kw)}`;
      nodes.push({
        id: tid, label: sanitizeLabel(kw), kind: 'tag',
        source: { type: 'keyword', ref: kw }, sourceLocation: null,
        createdBy, createdAt: new Date().toISOString(), tags: [],
      });
      edges.push({
        source: pid, target: tid, relation: 'tagged_with',
        confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
        createdBy, createdAt: new Date().toISOString(),
      });
    }
    if (activeRepoId) {
      edges.push({
        source: pid, target: activeRepoId, relation: 'references',
        confidence: 'INFERRED', confidenceScore: 0.5, weight: 0.5,
        createdBy, createdAt: new Date().toISOString(),
      });
    }
  }
  return { nodes, edges, scanned: plugins.length };
}

module.exports = { extractPlugins };
