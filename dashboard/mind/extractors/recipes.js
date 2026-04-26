/**
 * Recipes extractor. Each recipe markdown (recipes/*.md and ~/.symphonee/
 * recipes/*.md) becomes a node. Frontmatter fields turn into edges:
 *   plugins: [a, b]         -> recipe --references--> plugin_a
 *   inputs: [{type: repo}]  -> recipe --references--> repo (when default known)
 *   intent: deep-code       -> recipe --tagged_with--> intent_deep-code
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFrontmatter } = require('./markdown');
const { sanitizeLabel } = require('../security');
const { makeIdFromLabel } = require('../ids');

const SEARCH_DIRS = (repoRoot) => [
  path.join(repoRoot, 'recipes'),
  path.join(os.homedir(), '.symphonee', 'recipes'),
];

function extractRecipes({ repoRoot, createdBy = 'mind/recipes' }) {
  const nodes = []; const edges = [];
  let scanned = 0;
  for (const dir of SEARCH_DIRS(repoRoot)) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
      const full = path.join(dir, f);
      let body; try { body = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      scanned++;
      const { fm } = parseFrontmatter(body);
      const stem = f.replace(/\.md$/i, '');
      const id = `recipe_${makeIdFromLabel(stem)}`;
      nodes.push({
        id, label: sanitizeLabel(fm.name || stem), kind: 'recipe',
        source: { type: 'recipe', ref: stem, file: full },
        sourceLocation: null,
        createdBy, createdAt: new Date().toISOString(),
        tags: ['recipe'],
        intent: fm.intent || null,
        description: fm.description || null,
      });

      // Plugin references
      const pluginsList = Array.isArray(fm.plugins) ? fm.plugins : [];
      for (const p of pluginsList) {
        const pid = `plugin_${p}`;
        edges.push({
          source: id, target: pid, relation: 'references',
          confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
          createdBy, createdAt: new Date().toISOString(),
        });
      }

      // Intent tag
      if (fm.intent) {
        const tid = `intent_${fm.intent}`;
        nodes.push({
          id: tid, label: sanitizeLabel(`intent:${fm.intent}`), kind: 'tag',
          source: { type: 'intent', ref: fm.intent }, sourceLocation: null,
          createdBy, createdAt: new Date().toISOString(), tags: [],
        });
        edges.push({
          source: id, target: tid, relation: 'tagged_with',
          confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
          createdBy, createdAt: new Date().toISOString(),
        });
      }
    }
  }
  return { nodes, edges, scanned };
}

module.exports = { extractRecipes };
