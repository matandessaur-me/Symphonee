'use strict';
// SECURITY-RELEVANT: resolveInRepo is the guard every route uses before
// touching the filesystem with a user-supplied path (CWE-22).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveInRepo, isUnsafeGitRef } = require('./safe-path');

const repo = path.resolve(__dirname, '..', '..'); // any absolute dir works

test('resolveInRepo: paths inside the repo resolve', () => {
  assert.equal(resolveInRepo(repo, 'README.md'), path.join(repo, 'README.md'));
  assert.equal(resolveInRepo(repo, 'a/b/c.js'), path.join(repo, 'a', 'b', 'c.js'));
  assert.equal(resolveInRepo(repo, ''), repo);          // repo root itself
  assert.equal(resolveInRepo(repo, '.'), repo);
  assert.equal(resolveInRepo(repo, 'a/../b'), path.join(repo, 'b')); // normalizes inside
});

test('resolveInRepo: traversal escapes -> null', () => {
  assert.equal(resolveInRepo(repo, '../outside.txt'), null);
  assert.equal(resolveInRepo(repo, '../../../../etc/passwd'), null);
  assert.equal(resolveInRepo(repo, 'a/../../outside'), null);
  assert.equal(resolveInRepo(repo, '..'), null);
});

test('resolveInRepo: absolute paths are confined too', () => {
  assert.equal(resolveInRepo(repo, '/etc/passwd'), null);
  // an absolute path that happens to be inside the repo is fine
  assert.equal(resolveInRepo(repo, path.join(repo, 'x.txt')), path.join(repo, 'x.txt'));
});

test('resolveInRepo: prefix-sibling dirs do not pass (repo vs repo-evil)', () => {
  const sibling = repo + '-evil/file.txt';
  assert.equal(resolveInRepo(repo, path.relative(repo, sibling)), null);
});

test('resolveInRepo: bad input -> null', () => {
  assert.equal(resolveInRepo(repo, null), null);
  assert.equal(resolveInRepo(repo, undefined), null);
  assert.equal(resolveInRepo('', 'x'), null);
  assert.equal(resolveInRepo(repo, 'a\0b'), null); // NUL byte
});

test('isUnsafeGitRef: flags and shell metacharacters rejected', () => {
  assert.equal(isUnsafeGitRef('HEAD'), false);
  assert.equal(isUnsafeGitRef('main'), false);
  assert.equal(isUnsafeGitRef('feature/x.y-z_1'), false);
  assert.equal(isUnsafeGitRef('abc1234'), false);
  assert.equal(isUnsafeGitRef('HEAD~2'), false);
  assert.equal(isUnsafeGitRef(''), true);
  assert.equal(isUnsafeGitRef(null), true);
  assert.equal(isUnsafeGitRef('--output=x'), true);   // flag injection
  assert.equal(isUnsafeGitRef('-p'), true);
  assert.equal(isUnsafeGitRef('a b'), true);
  assert.equal(isUnsafeGitRef('a;b'), true);
  assert.equal(isUnsafeGitRef('a`b'), true);
  assert.equal(isUnsafeGitRef('a"b'), true);
});
