'use strict';
// Guardrail: every *.test.js on disk MUST be matched by one of the npm test
// scripts, so a newly-added test can never silently fall out of `npm test`/CI.
//
// This replaces the old hand-maintained file lists in package.json, which had
// drifted: 11 server test files (the whole orchestrator suite + browser-router)
// existed on disk but were never run, and the renderer list even named a
// notes.test.js that no longer exists.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { globSync } = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(repoRoot, 'package.json'));

// Pull every quoted/bare glob argument out of a `node --test ...` script.
function patternsFor(script) {
  const s = pkg.scripts[script] || '';
  return (s.match(/(?:"[^"]+"|\S+)/g) || [])
    .map(tok => tok.replace(/^"|"$/g, ''))
    .filter(tok => tok.endsWith('.test.js'));
}

function matched(script) {
  const set = new Set();
  for (const pat of patternsFor(script)) {
    for (const f of globSync(pat, { cwd: repoRoot })) set.add(f.split(path.sep).join('/'));
  }
  return set;
}

test('every *.test.js on disk is covered by an npm test script', () => {
  const onDisk = globSync('{scripts,dashboard}/**/*.test.js', { cwd: repoRoot })
    .map(f => f.split(path.sep).join('/'))
    .filter(f => !f.includes('/node_modules/'));

  const covered = new Set([...matched('test:renderer'), ...matched('test:server')]);
  const uncovered = onDisk.filter(f => !covered.has(f)).sort();

  assert.deepEqual(uncovered, [],
    `These test files are not run by any npm test script:\n  ${uncovered.join('\n  ')}\n` +
    `Fix the globs in package.json (test:renderer / test:server).`);
});

test('renderer and server test sets do not overlap', () => {
  const r = matched('test:renderer');
  const overlap = [...matched('test:server')].filter(f => r.has(f)).sort();
  assert.deepEqual(overlap, [], `test files matched by BOTH suites:\n  ${overlap.join('\n  ')}`);
});

test('every glob pattern resolves to at least one file (no dead patterns)', () => {
  for (const script of ['test:renderer', 'test:server']) {
    for (const pat of patternsFor(script)) {
      const n = globSync(pat, { cwd: repoRoot }).length;
      assert.ok(n > 0, `pattern "${pat}" in ${script} matches no files`);
    }
  }
});
