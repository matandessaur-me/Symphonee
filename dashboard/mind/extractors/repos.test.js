'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractRepos } = require('./repos');

function makeGraph() {
  return {
    nodes: [
      { id: 'cwd_alpha', label: '@alpha', kind: 'tag' },
      { id: 'cwd_beta',  label: '@beta',  kind: 'tag' },
      { id: 'a_file_1',  label: 'a.ts',  kind: 'code' },
      { id: 'a_file_2',  label: 'b.ts',  kind: 'code' },
      { id: 'b_file_1',  label: 'c.ts',  kind: 'code' },
      { id: 'noise_tag', label: 'noise', kind: 'tag' },
    ],
    edges: [
      { source: 'a_file_1', target: 'cwd_alpha', relation: 'in_repo' },
      { source: 'a_file_2', target: 'cwd_alpha', relation: 'in_repo' },
      { source: 'b_file_1', target: 'cwd_beta',  relation: 'in_repo' },
    ],
  };
}

test('extractRepos: synthesizes one kind:repo per cwd_* tag', () => {
  const r = extractRepos(makeGraph());
  assert.equal(r.repos, 2);
  const repoNodes = r.nodes.filter(n => n.kind === 'repo');
  assert.equal(repoNodes.length, 2);
  const ids = repoNodes.map(n => n.id).sort();
  assert.deepEqual(ids, ['repo_node_alpha', 'repo_node_beta']);
});

test('extractRepos: emits member_of edges from every member', () => {
  const r = extractRepos(makeGraph());
  const memberEdges = r.edges.filter(e => e.relation === 'member_of');
  // 3 in_repo edges in the fixture -> 3 member_of edges in the result
  assert.equal(memberEdges.length, 3);
  const alphaMembers = memberEdges.filter(e => e.target === 'repo_node_alpha').map(e => e.source).sort();
  assert.deepEqual(alphaMembers, ['a_file_1', 'a_file_2']);
});

test('extractRepos: emits tagged_with bridge from cwd tag to repo', () => {
  const r = extractRepos(makeGraph());
  const bridges = r.edges.filter(e => e.relation === 'tagged_with');
  assert.equal(bridges.length, 2);
  for (const e of bridges) {
    assert.equal(e.source.startsWith('cwd_'), true);
    assert.equal(e.target.startsWith('repo_node_'), true);
  }
});

test('extractRepos: ignores non-cwd tags', () => {
  const r = extractRepos(makeGraph());
  // noise_tag is kind:tag but not a cwd_* — must not become a repo node
  for (const n of r.nodes) assert.notEqual(n.id, 'repo_node_noise_tag');
});

test('extractRepos: idempotent on empty input', () => {
  assert.deepEqual(extractRepos({ nodes: [], edges: [] }).nodes, []);
  assert.deepEqual(extractRepos({}).nodes, []);
  assert.deepEqual(extractRepos().nodes, []);
});
