'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractEntities, canonicalize, tokenize } = require('./entities');

test('canonicalize collapses surface forms to one key', () => {
  assert.equal(canonicalize('Bath Fitter'), 'bathfitter');
  assert.equal(canonicalize('bath_fitter'), 'bathfitter');
  assert.equal(canonicalize('Bath-Fitter'), 'bathfitter');
  assert.equal(canonicalize('BATHFITTER'), 'bathfitter');
  assert.equal(canonicalize('Builder.io'), 'builderio');
});

test('tokenize splits on separators and digit boundaries', () => {
  assert.deepEqual(tokenize('bath-fitter-listing-manager'), ['bath', 'fitter', 'listing', 'manager']);
  assert.deepEqual(tokenize('dyob3'), ['dyob', '3']);
  assert.deepEqual(tokenize('website_bathfitter_residential'), ['website', 'bathfitter', 'residential']);
});

test('extractEntities: auto-detects cross-repo brands from tag names', () => {
  const graph = {
    nodes: [
      { id: 'cwd_bath_fitter_listing_manager', label: '@bath-fitter-listing-manager', kind: 'tag' },
      { id: 'cwd_website_bathfitter_residential', label: '@website-bathfitter-residential', kind: 'tag' },
      { id: 'cwd_dyob3', label: '@dyob3', kind: 'tag' },
      { id: 'cwd_dyob_react_wordpress', label: '@dyob-react-wordpress', kind: 'tag' },
      { id: 'cwd_lonely', label: '@lonely', kind: 'tag' }, // no cross-repo overlap
    ],
    edges: [],
  };
  const r = extractEntities(graph);
  const labels = r.nodes.map(n => n.label).sort();
  assert.ok(labels.includes('Bath Fitter'), `expected Bath Fitter in ${labels.join(',')}`);
  assert.ok(labels.includes('Dyob'), `expected Dyob in ${labels.join(',')}`);
  // "Lonely" only appears in one repo, must NOT become an entity
  assert.ok(!labels.includes('Lonely'), `Lonely should not be an entity`);
});

test('extractEntities: plugin nodes always become entities', () => {
  const graph = {
    nodes: [
      { id: 'plugin_sanity', label: 'Sanity', kind: 'plugin' },
      { id: 'plugin_supabase', label: 'Supabase', kind: 'plugin' },
    ],
    edges: [],
  };
  const r = extractEntities(graph);
  assert.equal(r.entities, 2);
  const labels = r.nodes.map(n => n.label).sort();
  assert.deepEqual(labels, ['Sanity', 'Supabase']);
});

test('extractEntities: prefers human-readable surface form (with separators)', () => {
  // Two repos share the canonical key "bathfitter":
  //  - repo A surfaces it as the bigram "bath fitter" (tokenized from
  //    "bath-fitter-listing-manager")
  //  - repo B surfaces it as the unigram "bathfitter" (its slug already
  //    smushed, like "website-bathfitter-residential")
  // The more readable bigram should win the surface form.
  const graph = {
    nodes: [
      { id: 'cwd_bath_fitter_listing_manager',     label: '@bath-fitter-listing-manager',     kind: 'tag' },
      { id: 'cwd_website_bathfitter_residential',  label: '@website-bathfitter-residential',  kind: 'tag' },
    ],
    edges: [],
  };
  const r = extractEntities(graph);
  const labels = r.nodes.map(n => n.label);
  assert.ok(labels.includes('Bath Fitter'), `expected 'Bath Fitter', got [${labels.join(', ')}]`);
});

test('extractEntities: stopwords are filtered (no website/manager entities)', () => {
  const graph = {
    nodes: [
      { id: 'cwd_alpha_website', label: '@alpha-website', kind: 'tag' },
      { id: 'cwd_beta_website',  label: '@beta-website',  kind: 'tag' },
      { id: 'cwd_alpha_manager', label: '@alpha-manager', kind: 'tag' },
      { id: 'cwd_beta_manager',  label: '@beta-manager',  kind: 'tag' },
    ],
    edges: [],
  };
  const r = extractEntities(graph);
  for (const n of r.nodes) {
    const key = canonicalize(n.label);
    assert.notEqual(key, 'website', 'website is stopword');
    assert.notEqual(key, 'manager', 'manager is stopword');
  }
});

test('extractEntities: emits mentions edges from matching nodes', () => {
  const graph = {
    nodes: [
      { id: 'plugin_sanity', label: 'Sanity', kind: 'plugin' },
      { id: 'note_x', label: 'Setting up Sanity for the project', kind: 'note' },
      { id: 'note_y', label: 'Random unrelated note', kind: 'note' },
    ],
    edges: [],
  };
  const r = extractEntities(graph);
  const mentions = r.edges.filter(e => e.relation === 'mentions' && e.target === 'entity_sanity');
  const sources = mentions.map(e => e.source).sort();
  // The plugin node itself isn't excluded (kind:plugin is in the scan loop)
  // but the mention from note_x is what we care about; note_y must NOT match.
  assert.ok(sources.includes('note_x'), 'note_x should mention Sanity');
  assert.ok(!sources.includes('note_y'), 'note_y should NOT mention Sanity');
});

test('extractEntities: confidence shape on mention edges', () => {
  const graph = {
    nodes: [
      { id: 'plugin_sanity', label: 'Sanity', kind: 'plugin' },
      { id: 'note_x', label: 'Sanity is great', kind: 'note' },
    ],
    edges: [],
  };
  const r = extractEntities(graph);
  const e = r.edges.find(x => x.relation === 'mentions' && x.source === 'note_x');
  assert.ok(e);
  assert.equal(e.confidence, 'EXTRACTED');
  assert.equal(e.confidenceScore, 0.9);
  assert.equal(e.createdBy, 'mind/entities');
});

test('extractEntities: idempotent on empty input', () => {
  assert.deepEqual(extractEntities({ nodes: [], edges: [] }).nodes, []);
  assert.deepEqual(extractEntities({}).nodes, []);
  assert.deepEqual(extractEntities().nodes, []);
});

test('extractEntities: declared entity-relations emit conceptually_related_to edges', () => {
  // Build a tiny .symphonee/entity-relations.json in a tmp dir and verify
  // the extractor reads it + emits the cross-entity edge.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-rels-'));
  try {
    fs.mkdirSync(path.join(root, '.symphonee'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.symphonee', 'entity-relations.json'),
      JSON.stringify({ relations: [{ from: 'DYOB', to: 'Bath Fitter', relation: 'part_of', label: 'DYOB is a Bath Fitter program' }] }),
    );
    const graph = {
      nodes: [
        { id: 'cwd_bath_fitter_x', label: '@bath-fitter-x', kind: 'tag' },
        { id: 'cwd_bath_fitter_y', label: '@bath-fitter-y', kind: 'tag' },
        { id: 'cwd_dyob3',         label: '@dyob3',         kind: 'tag' },
        { id: 'cwd_dyob_react',    label: '@dyob-react',    kind: 'tag' },
      ],
      edges: [],
    };
    const r = extractEntities(graph, { repoRoot: root });
    assert.equal(r.declaredRelations, 1);
    const rel = r.edges.find(e => e.relation === 'conceptually_related_to');
    assert.ok(rel, 'expected conceptually_related_to edge');
    assert.equal(rel.source, 'entity_dyob');
    assert.equal(rel.target, 'entity_bathfitter');
    assert.equal(rel.relationKind, 'part_of');
    assert.equal(rel.relationLabel, 'DYOB is a Bath Fitter program');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extractEntities: declared relation skipped when one side is unknown', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-rels-skip-'));
  try {
    fs.mkdirSync(path.join(root, '.symphonee'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.symphonee', 'entity-relations.json'),
      JSON.stringify({ relations: [{ from: 'DYOB', to: 'NeverHeardOf', relation: 'part_of' }] }),
    );
    const graph = {
      nodes: [
        { id: 'cwd_dyob3',      label: '@dyob3',      kind: 'tag' },
        { id: 'cwd_dyob_react', label: '@dyob-react', kind: 'tag' },
      ],
      edges: [],
    };
    const r = extractEntities(graph, { repoRoot: root });
    assert.equal(r.declaredRelations, 0);
    assert.equal(r.edges.filter(e => e.relation === 'conceptually_related_to').length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
