'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveImport } = require('./resolve-import');

const fset = new Set([
  'src/index.ts',
  'src/lib/api.ts',
  'src/components/Header.tsx',
  'src/styles/main.scss',
  'src/styles/_partial.scss',
  'src/utils/index.ts',
]);

test('resolves relative paths with extension elision', () => {
  assert.equal(resolveImport({ spec: './lib/api', fromFile: 'src/index.ts', fileSet: fset }), 'src/lib/api.ts');
  assert.equal(resolveImport({ spec: './components/Header', fromFile: 'src/index.ts', fileSet: fset }), 'src/components/Header.tsx');
});

test('resolves directory imports via index files', () => {
  assert.equal(resolveImport({ spec: './utils', fromFile: 'src/index.ts', fileSet: fset }), 'src/utils/index.ts');
});

test('returns null for external modules', () => {
  assert.equal(resolveImport({ spec: 'react', fromFile: 'src/index.ts', fileSet: fset }), null);
});

test('SCSS partial _ prefix fallback', () => {
  assert.equal(resolveImport({ spec: './partial', fromFile: 'src/styles/main.scss', fileSet: fset, kind: 'css' }), 'src/styles/_partial.scss');
});

test('handles backslash separators in fromFile', () => {
  assert.equal(resolveImport({ spec: './api', fromFile: 'src\\lib\\api.ts', fileSet: fset }), 'src/lib/api.ts');
});

test('alias resolution path', () => {
  const aliases = { aliases: [{ pattern: '@/*', prefix: '@/', suffix: '', exact: false, targets: [{ prefix: 'src/', suffix: '', exact: false }] }] };
  assert.equal(resolveImport({ spec: '@/components/Header', fromFile: 'src/index.ts', fileSet: fset, aliases }), 'src/components/Header.tsx');
});
