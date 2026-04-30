'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadPathAliases, resolveAlias, _stripJsonComments, _compilePattern } = require('./aliases');

function tmpRoot(prefix = 'symphonee-test-aliases') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

test('stripJsonComments strips // and /* */ but preserves strings', () => {
  const src = '{ "a": "//b", /* drop */ "c": 1 } // tail';
  const out = _stripJsonComments(src);
  assert.ok(out.includes('"a": "//b"'));
  assert.ok(!out.includes('/* drop */'));
  assert.ok(!out.includes('// tail'));
});

test('compilePattern: exact and wildcard', () => {
  assert.deepEqual(_compilePattern('@/foo'), { prefix: '@/foo', suffix: '', exact: true });
  assert.deepEqual(_compilePattern('@/foo/*'), { prefix: '@/foo/', suffix: '', exact: false });
  assert.deepEqual(_compilePattern('*.scss'), { prefix: '', suffix: '.scss', exact: false });
  assert.equal(_compilePattern('@/*/*'), null, 'multi-star is rejected');
});

test('loadPathAliases reads tsconfig paths', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['src/*'], '@lib': ['src/lib/index'] },
    },
  }));
  const a = loadPathAliases(root);
  assert.equal(a.aliases.length, 2);
  assert.equal(resolveAlias('@/components/Header', a), 'src/components/Header');
  assert.equal(resolveAlias('@lib', a), 'src/lib/index');
  assert.equal(resolveAlias('react', a), null, 'unknown spec returns null');
});

test('loadPathAliases follows extends', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'tsconfig.base.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@base/*': ['shared/*'] } },
  }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    extends: './tsconfig.base.json',
    compilerOptions: { paths: { '@app/*': ['app/*'] } },
  }));
  const a = loadPathAliases(root);
  const names = a.aliases.map(x => x.pattern).sort();
  assert.deepEqual(names, ['@app/*', '@base/*']);
});

test('loadPathAliases handles missing config gracefully', () => {
  const root = tmpRoot();
  const a = loadPathAliases(root);
  assert.deepEqual(a.aliases, []);
});
