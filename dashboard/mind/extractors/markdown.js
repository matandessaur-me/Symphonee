/**
 * Generic markdown extractor. Used by the notes extractor and the doc/CLI-
 * memory extractor. Walks markdown text and extracts:
 *
 *   - The document itself as a node
 *   - Every [[wikilink]] as an edge (relation: links_to, EXTRACTED)
 *   - Every markdown link [text](target) as an edge (relation: references, EXTRACTED)
 *   - Frontmatter `tags:` as tagged_with edges (INFERRED)
 *   - Top-level headings as sub-nodes anchored to the document (relation: contains)
 *
 * Pure function: takes (id, label, kind, source, body) and returns
 * { nodes, edges } in canonical schema. The caller decides what `kind` and
 * `source` mean and what to do with dangling targets.
 */

const { makeIdFromLabel, normalizeId } = require('../ids');
const { sanitizeLabel } = require('../security');

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
const MD_LINK_RE = /(?<!\!)\[([^\]]+)\]\(([^)]+)\)/g;
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/gm;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(body) {
  const m = body.match(FRONTMATTER_RE);
  if (!m) return { fm: {}, rest: body };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    let val = kv[2];
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    fm[kv[1]] = val;
  }
  return { fm, rest: body.slice(m[0].length) };
}

function extractMarkdown({ id, label, kind, source, body, createdBy = 'extractor', tagPrefix = 'doc' }) {
  if (!id || typeof body !== 'string') return { nodes: [], edges: [] };
  const { fm, rest } = parseFrontmatter(body);
  const nodes = [];
  const edges = [];

  const tags = []
    .concat(Array.isArray(fm.tags) ? fm.tags : [])
    .concat(typeof fm.tags === 'string' ? [fm.tags] : []);

  nodes.push({
    id, label: sanitizeLabel(label), kind,
    source: source || null,
    sourceLocation: null,
    createdBy, createdAt: new Date().toISOString(),
    tags, frontmatter: fm,
  });

  // Tag nodes
  for (const t of tags) {
    if (!t) continue;
    const tid = `tag_${normalizeId(t)}`;
    nodes.push({
      id: tid, label: sanitizeLabel(`#${t}`), kind: 'tag',
      source: { type: 'tag', ref: t }, sourceLocation: null,
      createdBy, createdAt: new Date().toISOString(), tags: [],
    });
    edges.push({
      source: id, target: tid, relation: 'tagged_with',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: new Date().toISOString(),
    });
  }

  // Wikilinks
  WIKILINK_RE.lastIndex = 0;
  let wm;
  while ((wm = WIKILINK_RE.exec(rest))) {
    const target = wm[1].trim();
    if (!target) continue;
    const targetId = makeIdFromLabel(target, tagPrefix);
    edges.push({
      source: id, target: targetId, relation: 'links_to',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: new Date().toISOString(),
    });
  }

  // Markdown links - only count internal anchor-style refs, skip external http
  MD_LINK_RE.lastIndex = 0;
  let mm;
  while ((mm = MD_LINK_RE.exec(rest))) {
    const target = mm[2].trim();
    if (/^(https?:|mailto:|tel:|#)/.test(target)) continue;
    const cleaned = target.replace(/\.md(#.*)?$/, '').replace(/^\.\//, '');
    if (!cleaned) continue;
    const targetId = makeIdFromLabel(cleaned, tagPrefix);
    edges.push({
      source: id, target: targetId, relation: 'references',
      confidence: 'EXTRACTED', confidenceScore: 0.9, weight: 1.0,
      createdBy, createdAt: new Date().toISOString(),
    });
  }

  // Top-level headings - useful for big docs (CLAUDE.md is 16K, INSTRUCTIONS 14K).
  // IDs are content-derived so the same heading text across files collapses to
  // ONE shared concept node ("the ABSOLUTE RULES section is the same idea
  // wherever it appears"). This also makes incremental rebuild deterministic:
  // the property test fails otherwise because sequential __h1/__h2 IDs get
  // remapped differently each pass.
  HEADING_RE.lastIndex = 0;
  let hm;
  const seenHeadings = new Set();
  while ((hm = HEADING_RE.exec(rest))) {
    const depth = hm[1].length;
    if (depth > 2) continue; // h1/h2 only - cap node count
    const text = hm[2].trim();
    if (!text) continue;
    const hid = `heading_${normalizeId(text).slice(0, 60)}`;
    if (!seenHeadings.has(hid)) {
      seenHeadings.add(hid);
      nodes.push({
        id: hid, label: sanitizeLabel(text), kind: 'concept',
        source: { type: 'heading', ref: text },
        sourceLocation: { line: rest.slice(0, hm.index).split('\n').length },
        createdBy, createdAt: new Date().toISOString(), tags: [],
      });
    }
    edges.push({
      source: id, target: hid, relation: 'contains',
      confidence: 'EXTRACTED', confidenceScore: 1.0, weight: 1.0,
      createdBy, createdAt: new Date().toISOString(),
    });
  }

  return { nodes, edges };
}

module.exports = { extractMarkdown, parseFrontmatter };
