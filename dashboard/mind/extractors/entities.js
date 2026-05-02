/**
 * Phase A enrichment extractor: canonical entity layer.
 *
 * Detects brands / products / projects / orgs that recur across the graph
 * and synthesizes one `kind:entity` hub per canonical key, with `mentions`
 * edges from every node whose searchable text contains the entity. The
 * point is connection: today the brain has six cross-repo edges between
 * Bath Fitter repos and five of those are template noise. After this, a
 * single Bath Fitter entity node fans out to every repo that touches the
 * brand.
 *
 * Deterministic. No LLM. Pure additive: runs over the merged graph after
 * every other extractor and emits a fragment that nothing else removes.
 *
 * Candidates come from three sources, in this order:
 *   1. Plugin nodes already in the graph (kind:plugin) - always promoted.
 *   2. n-grams (1-3) drawn from repo slugs that appear in >=2 repos and
 *      survive the stop-list. This is what catches "bathfitter" without
 *      anyone declaring it.
 *   3. An optional explicit seed list (`opts.seedEntities`) for brands the
 *      auto-detector misses (e.g. a single-repo brand the user wants
 *      surfaced).
 *
 * A canonical key is `label.toLowerCase().replace(/[\s_.\-]+/g, '')`. Every
 * surface form ("Bath Fitter", "bathfitter", "bath_fitter", "Bath-Fitter")
 * collapses to the same key, so the entity hub lights up regardless of how
 * a node spells the brand. We require min 4 chars to keep matches
 * meaningful.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Generic words we never want as entities. Kept conservative on purpose —
// the goal is to drop obvious filler ("website", "manager") without losing
// real product names ("supabase", "builderio"). Matching is on the
// canonical key, so all entries are lowercase + space-stripped.
const STOPWORDS = new Set([
  // language / runtime / ecosystem
  'react', 'reactjs', 'next', 'nextjs', 'node', 'nodejs', 'vue', 'vuejs',
  'angular', 'svelte', 'astro', 'remix', 'gatsby', 'express', 'koa',
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp',
  'dotnet', 'aspnet', 'php', 'ruby', 'rails', 'laravel', 'flask', 'fastapi',
  'redux', 'zustand', 'jotai', 'mobx', 'graphql', 'rest', 'json', 'yaml',
  'html', 'css', 'sass', 'scss', 'tailwind', 'styled', 'mui', 'antd', 'shadcn',
  // file types / tooling
  'eslint', 'prettier', 'webpack', 'vite', 'rollup', 'babel', 'jest', 'vitest',
  'mocha', 'cypress', 'playwright', 'pwa', 'ssr', 'csr', 'isr', 'spa',
  // generic site/app vocabulary
  'website', 'site', 'sites', 'app', 'apps', 'page', 'pages', 'project',
  'projects', 'manager', 'listing', 'listings', 'form', 'forms',
  'internal', 'external', 'public', 'private', 'admin', 'dashboard',
  'home', 'about', 'contact', 'services', 'service', 'product', 'products',
  'feature', 'features', 'demo', 'test', 'tests', 'beta', 'alpha', 'staging',
  'prod', 'production', 'dev', 'development', 'release', 'releases',
  'common', 'shared', 'base', 'core', 'lib', 'libs', 'utils', 'util',
  'helpers', 'helper', 'config', 'configs', 'tools', 'tool',
  // descriptors that appear in repo names but aren't brands
  'residential', 'commercial', 'marketing', 'analytics', 'media',
  'careers', 'career', 'jobs', 'job', 'lead', 'leads', 'sales', 'crm',
  'cms', 'main', 'old', 'new', 'legacy', 'v1', 'v2', 'v3', 'v4', 'v5',
  // common organizational parent-dir names. these would otherwise
  // become brand entities just because every repo lives under one of
  // them (e.g. C:\Code\Personal\* groups every user project).
  'personal', 'projects', 'project', 'repos', 'repo', 'workspace',
  'workspaces', 'github', 'gitlab', 'documents', 'docs',
  // overly generic 4-letter false positives noticed during dev
  'code', 'data', 'file', 'item', 'user', 'auth', 'team', 'work', 'live',
  'true', 'false', 'null',
]);

const MIN_CANONICAL_LEN = 4;
const MAX_GRAM = 3;

function canonicalize(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().replace(/[\s_.\-]+/g, '');
}

function tokenize(s) {
  if (typeof s !== 'string') return [];
  // Split on the usual repo-slug separators AND digit boundaries so that
  // "dyob3" -> ["dyob", "3"] (gives us the "dyob" entity even though only
  // one repo is named exactly "dyob3").
  return s
    .split(/[\s_.\-/]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/g)
    .map(t => t.trim())
    .filter(Boolean);
}

function titleCase(s) {
  if (!s) return s;
  return s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function entityIdFromKey(key) {
  return `entity_${key.replace(/[^a-z0-9]+/g, '_')}`;
}

// Domain knowledge the auto-detector can't infer: explicit relationships
// between entities. Loaded from <repoRoot>/.symphonee/entity-relations.json
// when available. Format:
//   { "relations": [
//       { "from": "dyob", "to": "bathfitter", "relation": "part_of",
//         "label": "DYOB is a Bath Fitter program" },
//       ...
//   ] }
// `from` and `to` may be any surface form - we canonicalize them. Allowed
// relations: 'part_of', 'alias_of', 'related_to'. They all map to the
// schema's 'conceptually_related_to' relation today (a shared bucket
// keeps schema.RELATIONS small) with the user-supplied semantic label
// preserved in the edge's `relationLabel` field for UI rendering.
function loadEntityRelations(repoRoot) {
  if (!repoRoot) return [];
  const candidates = [
    path.join(repoRoot, '.symphonee', 'entity-relations.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      const data = JSON.parse(txt);
      const list = Array.isArray(data) ? data : (Array.isArray(data.relations) ? data.relations : []);
      const out = [];
      for (const rel of list) {
        if (!rel || typeof rel !== 'object') continue;
        const from = canonicalize(rel.from || '');
        const to = canonicalize(rel.to || '');
        if (!from || !to || from === to) continue;
        out.push({
          from,
          to,
          relationKind: typeof rel.relation === 'string' ? rel.relation : 'related_to',
          label: typeof rel.label === 'string' ? rel.label : null,
          source: p,
        });
      }
      return out;
    } catch (_) { /* ignore parse errors - the file is user-edited */ }
  }
  return [];
}

function extractEntities({ nodes = [], edges = [] } = {}, opts = {}) {
  if (!Array.isArray(nodes) || !nodes.length) {
    return { nodes: [], edges: [], scanned: 0, entities: 0, mentions: 0 };
  }

  const seedEntities = Array.isArray(opts.seedEntities) ? opts.seedEntities : [];

  // ── Phase 1: collect candidates ──────────────────────────────────────────
  // candidate canonical key -> { label: pretty surface form, sources: Set }
  const candidates = new Map();
  function addCandidate(rawLabel, source) {
    const key = canonicalize(rawLabel);
    if (!key || key.length < MIN_CANONICAL_LEN) return;
    if (STOPWORDS.has(key)) return;
    let entry = candidates.get(key);
    if (!entry) {
      entry = { key, label: rawLabel, sources: new Set() };
      candidates.set(key, entry);
    } else {
      // Prefer the most human-readable surface form (separators win),
      // tiebreaking on shortness.
      const prevHasSpace = /\s/.test(entry.label);
      const newHasSpace = /\s/.test(rawLabel);
      if (newHasSpace && !prevHasSpace) entry.label = rawLabel;
      else if (newHasSpace === prevHasSpace && rawLabel.length < entry.label.length) entry.label = rawLabel;
    }
    if (source) entry.sources.add(source);
  }

  // 1a. Plugin nodes -> always entities.
  for (const n of nodes) {
    if (n && n.kind === 'plugin' && typeof n.label === 'string') {
      addCandidate(n.label, 'plugin');
    }
  }

  // 1b. Repo n-grams. Pull each cwd_* tag, tokenize, build n-grams, count
  // cross-repo presence. Only n-grams seen in >=2 repos qualify (auto-
  // detection's whole point: cross-repo presence is the signal).
  const repoSlugs = [];
  for (const n of nodes) {
    if (n && n.kind === 'tag' && typeof n.id === 'string' && n.id.startsWith('cwd_')) {
      repoSlugs.push(n.id.replace(/^cwd_/, ''));
    }
  }
  const ngramRepoCount = new Map(); // canonicalKey -> Set<repoSlug>
  const ngramSurface = new Map();   // canonicalKey -> prettiest surface
  for (const slug of repoSlugs) {
    const toks = tokenize(slug);
    for (let g = 1; g <= MAX_GRAM; g++) {
      for (let i = 0; i + g <= toks.length; i++) {
        const piece = toks.slice(i, i + g).join(' ');
        const key = canonicalize(piece);
        if (!key || key.length < MIN_CANONICAL_LEN) continue;
        if (STOPWORDS.has(key)) continue;
        if (/^\d+$/.test(key)) continue; // pure-numeric n-grams are noise
        if (!ngramRepoCount.has(key)) ngramRepoCount.set(key, new Set());
        ngramRepoCount.get(key).add(slug);
        // Prefer the most human-readable surface form: a bigram "bath
        // fitter" beats the smushed unigram "bathfitter" even though it's
        // one char longer. Tiebreak by length.
        const prev = ngramSurface.get(key);
        if (!prev) {
          ngramSurface.set(key, piece);
        } else {
          const prevHasSpace = /\s/.test(prev);
          const pieceHasSpace = /\s/.test(piece);
          if (pieceHasSpace && !prevHasSpace) ngramSurface.set(key, piece);
          else if (pieceHasSpace === prevHasSpace && piece.length < prev.length) ngramSurface.set(key, piece);
        }
      }
    }
  }
  for (const [key, repos] of ngramRepoCount.entries()) {
    if (repos.size < 2) continue;
    addCandidate(titleCase(ngramSurface.get(key) || key), 'repo-ngram');
  }

  // 1c. Parent-directory groupings. When several repos live under the same
  // directory ("C:/Code/Personal/Playdate/COA-Playdate", "../RAT", "../BUREAU"),
  // that parent dir name is almost always a meaningful brand or programme
  // grouping the slug-based n-gram pass can't see (because no individual
  // slug shares it). Track which repos belong to each parent so we can
  // emit explicit member edges later.
  const parentDirToRepos = new Map(); // parentDirCanonicalKey -> Set<repoName>
  const parentDirSurface = new Map(); // canonicalKey -> prettiest surface
  const repoPaths = (opts.repoPaths && typeof opts.repoPaths === 'object') ? opts.repoPaths : {};
  for (const [repoName, repoPath] of Object.entries(repoPaths)) {
    if (typeof repoPath !== 'string' || !repoPath) continue;
    const parent = path.basename(path.dirname(repoPath));
    if (!parent) continue;
    const key = canonicalize(parent);
    if (!key || key.length < MIN_CANONICAL_LEN) continue;
    if (STOPWORDS.has(key)) continue;
    if (/^\d+$/.test(key)) continue;
    if (!parentDirToRepos.has(key)) parentDirToRepos.set(key, new Set());
    parentDirToRepos.get(key).add(repoName);
    if (!parentDirSurface.has(key)) parentDirSurface.set(key, parent);
  }
  for (const [key, repos] of parentDirToRepos.entries()) {
    if (repos.size < 2) continue;
    addCandidate(parentDirSurface.get(key) || key, 'parent-dir');
  }

  // 1d. Explicit seeds (user-curated overrides).
  for (const seed of seedEntities) {
    if (typeof seed === 'string') addCandidate(seed, 'seed');
    else if (seed && typeof seed.label === 'string') addCandidate(seed.label, 'seed');
  }

  if (!candidates.size) {
    return { nodes: [], edges: [], scanned: nodes.length, entities: 0, mentions: 0 };
  }

  // ── Phase 2: build matchable canonical-key index ─────────────────────────
  const keys = Array.from(candidates.keys());
  // Sort longest-first so multi-word brands win over their substrings if
  // both qualify (e.g. "bathfitter" beats "bath" if both somehow ended up
  // candidates).
  keys.sort((a, b) => b.length - a.length);

  // ── Phase 3: synthesize entity nodes ─────────────────────────────────────
  const createdAt = new Date().toISOString();
  const newNodes = [];
  const entityIdByKey = new Map();
  for (const key of keys) {
    const c = candidates.get(key);
    const id = entityIdFromKey(key);
    entityIdByKey.set(key, id);
    newNodes.push({
      id,
      label: c.label,
      kind: 'entity',
      source: { type: 'entity-enrichment', ref: key },
      tags: ['entity', ...Array.from(c.sources)],
      createdBy: 'mind/entities',
      createdAt,
    });
  }

  // ── Phase 4: scan every node, emit mentions edges ────────────────────────
  // Searchable text per node: label + source.ref + content (drawers) +
  // description/summary/answer when present. Cap each node's scan text to
  // 4kb to keep this O(n) on graph size.
  const newEdges = [];
  let mentions = 0;
  const seen = new Set(); // dedupe edges (sourceId + entityId)

  for (const n of nodes) {
    if (!n || !n.id) continue;
    // Don't link the entity node to itself; don't link tags/repo nodes
    // (those are structural, not content-bearing) — except cwd_* tags
    // because their @label IS the brand mention we want to capture.
    if (n.kind === 'entity') continue;
    if (n.kind === 'repo') continue;
    if (n.kind === 'tag' && !(typeof n.id === 'string' && n.id.startsWith('cwd_'))) continue;

    const parts = [];
    if (typeof n.label === 'string') parts.push(n.label);
    const src = n.source || {};
    if (typeof src.ref === 'string') parts.push(src.ref);
    if (typeof n.description === 'string') parts.push(n.description);
    if (typeof n.summary === 'string') parts.push(n.summary);
    if (typeof n.answer === 'string') parts.push(n.answer);
    if (typeof n.content === 'string') parts.push(n.content);
    const text = parts.join(' ').slice(0, 4000);
    if (!text) continue;
    const haystack = canonicalize(text);
    if (!haystack) continue;

    for (const key of keys) {
      if (!haystack.includes(key)) continue;
      const dedupKey = `${n.id}${key}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const targetId = entityIdByKey.get(key);
      newEdges.push({
        source: n.id,
        target: targetId,
        relation: 'mentions',
        confidence: 'EXTRACTED',
        confidenceScore: 0.9,
        weight: 1,
        createdBy: 'mind/entities',
        createdAt,
      });
      mentions++;
    }
  }

  // ── Phase 4.5: parent-directory member edges ────────────────────────────
  // For each parent-dir entity, link each member repo's cwd_* tag to it
  // directly. Independent of text scan - guarantees the connection even if
  // the cwd label doesn't literally contain the parent dir name (which is
  // common: cwd_coa_playdate's label '@coa-playdate' has no 'playdate' in
  // canonicalize-stripped form? It does: 'coaplaydate' contains 'playdate',
  // so the scan would catch it. But other groupings - e.g. 'Personal'
  // grouping every personal project - won't appear in slug labels.)
  let parentDirEdges = 0;
  for (const [parentKey, repos] of parentDirToRepos.entries()) {
    if (repos.size < 2) continue;
    const entityId = entityIdByKey.get(parentKey);
    if (!entityId) continue; // candidate filtered out (stopword, length)
    for (const repoName of repos) {
      const cwdSlug = String(repoName).replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase();
      const cwdId = `cwd_${cwdSlug}`;
      // Verify cwd tag exists in the merged graph before pointing at it.
      if (!nodes.some(n => n.id === cwdId)) continue;
      const dedupKey = `${cwdId}\x01${parentKey}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      newEdges.push({
        source: cwdId,
        target: entityId,
        relation: 'mentions',
        confidence: 'EXTRACTED',
        confidenceScore: 1,
        weight: 1,
        createdBy: 'mind/entities/parent-dir',
        createdAt,
      });
      parentDirEdges++;
      mentions++;
    }
  }

  // ── Phase 5: declared entity relations ──────────────────────────────────
  // Domain links the auto-detector can't infer (e.g., DYOB is part of
  // Bath Fitter). Read from `.symphonee/entity-relations.json`. Edges land
  // as `conceptually_related_to` with the user-supplied kind preserved on
  // `relationLabel` and `relationKind`.
  let declaredRelations = 0;
  if (opts.repoRoot) {
    const declared = loadEntityRelations(opts.repoRoot);
    for (const rel of declared) {
      const fromId = entityIdByKey.get(rel.from);
      const toId = entityIdByKey.get(rel.to);
      // Only emit when BOTH sides exist as entity nodes - silently skip
      // declarations that name an entity the auto-detector hasn't picked
      // up (the user can add it via opts.seedEntities).
      if (!fromId || !toId) continue;
      newEdges.push({
        source: fromId,
        target: toId,
        relation: 'conceptually_related_to',
        relationKind: rel.relationKind,
        relationLabel: rel.label || null,
        confidence: 'EXTRACTED',
        confidenceScore: 1,
        weight: 2,
        createdBy: 'mind/entities/relations',
        createdAt,
      });
      declaredRelations++;
    }
  }

  // ── Phase 6: AUTOMATIC entity-to-entity relationships ───────────────────
  // Two entities mentioned by the same set of source nodes are almost
  // always related: the Bath Fitter Listing Manager docs that name DYOB,
  // the DYOB3 docs that name Bath Fitter, drawer turns that talk about
  // both. Compute pairwise Jaccard over each entity's mention set and
  // emit conceptually_related_to (INFERRED) whenever the overlap is
  // statistically meaningful.
  //
  // Thresholds picked to favour precision: at least 3 shared mention
  // sources AND Jaccard >= 0.10. With those bars, a pair of plugin
  // entities that happen to both appear in one CLAUDE.md doesn't
  // generate noise, but a pair like Bath Fitter / DYOB - mentioned
  // together across docs, drawers, and notes - lights up automatically.
  // Edges from this phase carry confidence INFERRED; explicit
  // declarations from entity-relations.json win on rebuild because
  // they come first and Phase 6 skips pairs already connected.
  const MIN_SHARED = 3;
  const MIN_JACCARD = 0.10;
  const mentionsByEntity = new Map(); // entityId -> Set<sourceNodeId>
  for (const e of newEdges) {
    if (e.relation !== 'mentions') continue;
    if (!mentionsByEntity.has(e.target)) mentionsByEntity.set(e.target, new Set());
    mentionsByEntity.get(e.target).add(e.source);
  }
  // Track pairs we've already emitted (or that Phase 5 declared) so we
  // don't double-write.
  const pairKey = (a, b) => (a < b) ? `${a}\x01${b}` : `${b}\x01${a}`;
  const claimedPairs = new Set();
  for (const e of newEdges) {
    if (e.relation === 'conceptually_related_to') {
      claimedPairs.add(pairKey(e.source, e.target));
    }
  }
  const entityIds = Array.from(mentionsByEntity.keys());
  let coMentionRelations = 0;
  for (let i = 0; i < entityIds.length; i++) {
    const a = entityIds[i];
    const A = mentionsByEntity.get(a);
    if (A.size < MIN_SHARED) continue;
    for (let j = i + 1; j < entityIds.length; j++) {
      const b = entityIds[j];
      const B = mentionsByEntity.get(b);
      if (B.size < MIN_SHARED) continue;
      if (claimedPairs.has(pairKey(a, b))) continue;
      // Compute intersection cheaply: walk the smaller set.
      const [small, large] = A.size <= B.size ? [A, B] : [B, A];
      let inter = 0;
      for (const id of small) if (large.has(id)) inter++;
      if (inter < MIN_SHARED) continue;
      const union = A.size + B.size - inter;
      const jaccard = inter / union;
      if (jaccard < MIN_JACCARD) continue;
      newEdges.push({
        source: a,
        target: b,
        relation: 'conceptually_related_to',
        relationKind: 'co_mentioned',
        relationLabel: `Co-mentioned by ${inter} nodes (Jaccard ${jaccard.toFixed(2)})`,
        confidence: 'INFERRED',
        confidenceScore: 0.6 + Math.min(0.3, jaccard),
        weight: jaccard,
        jaccard,
        sharedMentions: inter,
        createdBy: 'mind/entities/co-mention',
        createdAt,
      });
      claimedPairs.add(pairKey(a, b));
      coMentionRelations++;
    }
  }

  return {
    nodes: newNodes,
    edges: newEdges,
    scanned: nodes.length,
    entities: newNodes.length,
    mentions,
    declaredRelations,
    coMentionRelations,
  };
}

module.exports = { extractEntities, canonicalize, tokenize, loadEntityRelations };
