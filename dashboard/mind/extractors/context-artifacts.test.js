'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractContextArtifacts, readArtifactsConfig } = require('./context-artifacts');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-test-ca-'));
}

test('readArtifactsConfig handles missing config', () => {
  const root = tmpRoot();
  const cfg = readArtifactsConfig(root, root);
  assert.deepEqual(cfg.artifacts, []);
});

test('extracts one artifact group + per-file nodes', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.symphonee'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'schema.sql'), 'CREATE TABLE users (id INT);');
  fs.writeFileSync(path.join(root, '.symphonee', 'context-artifacts.json'), JSON.stringify({
    artifacts: [{ name: 'schema', path: './docs/schema.sql', description: 'Postgres schema. Check before writing migrations.' }],
  }));
  const f = extractContextArtifacts({ repoRoot: root, activeRepoPath: root });
  assert.ok(f.nodes.find(n => n.id === 'artifact_schema'));
  assert.ok(f.nodes.find(n => n.kind === 'artifact' && n.source.type === 'artifact-file'));
  assert.equal(f.edges.filter(e => e.relation === 'contains').length, 1);
  // description is preserved on the group node
  const group = f.nodes.find(n => n.id === 'artifact_schema');
  assert.match(group.description, /migrations/);
});

test('directory artifact recurses into eligible files', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.symphonee'), { recursive: true });
  fs.mkdirSync(path.join(root, 'adr'), { recursive: true });
  fs.writeFileSync(path.join(root, 'adr', '001.md'), '# ADR 1');
  fs.writeFileSync(path.join(root, 'adr', '002.md'), '# ADR 2');
  fs.writeFileSync(path.join(root, '.symphonee', 'context-artifacts.json'), JSON.stringify({
    artifacts: [{ name: 'adrs', path: './adr/', description: 'ADRs.' }],
  }));
  const f = extractContextArtifacts({ repoRoot: root, activeRepoPath: root });
  const fileNodes = f.nodes.filter(n => n.source.type === 'artifact-file');
  assert.equal(fileNodes.length, 2);
});

test('returns empty when config is malformed', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.symphonee'), { recursive: true });
  fs.writeFileSync(path.join(root, '.symphonee', 'context-artifacts.json'), '{ not valid json');
  const f = extractContextArtifacts({ repoRoot: root, activeRepoPath: root });
  assert.deepEqual(f.nodes, []);
});
