'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractMultiLang, langOf, supportedExts } = require('./code-langs');

const stubResolve = (spec) => ({ target: 'ext_' + spec.replace(/[^a-z]/gi, '_'), unresolved: true });

test('langOf maps known extensions', () => {
  assert.equal(langOf('.go'), 'go');
  assert.equal(langOf('.rs'), 'rust');
  assert.equal(langOf('.kt'), 'kotlin');
  assert.equal(langOf('.unknown'), null);
});

test('supportedExts list is non-empty', () => {
  assert.ok(supportedExts().length >= 10);
});

test('Go: imports + func + struct', () => {
  const f = extractMultiLang({
    relPath: 'main.go', fullPath: '/x/main.go',
    body: 'package main\nimport "fmt"\nimport (\n  "os"\n)\nfunc main() {}\ntype Server struct {}',
    lang: 'go', createdBy: 'test', resolveOne: stubResolve,
  });
  assert.equal(f.edges.filter(e => e.relation === 'imports').length, 2);
  const decls = f.nodes.filter(n => n.source.type === 'symbol').map(n => n.label);
  assert.ok(decls.includes('main()'));
  assert.ok(decls.includes('Server'));
});

test('Rust: use + fn + struct', () => {
  const f = extractMultiLang({
    relPath: 'lib.rs', fullPath: '/x/lib.rs',
    body: 'use std::io;\npub fn run() {}\npub struct App;\n',
    lang: 'rust', createdBy: 'test', resolveOne: stubResolve,
  });
  assert.equal(f.edges.filter(e => e.relation === 'imports').length, 1);
  const decls = f.nodes.filter(n => n.source.type === 'symbol').map(n => n.label);
  assert.ok(decls.includes('run()'));
  assert.ok(decls.includes('App'));
});

test('Java: import + class + method', () => {
  const f = extractMultiLang({
    relPath: 'A.java', fullPath: '/x/A.java',
    body: 'package x;\nimport java.util.List;\npublic class Foo {\n  public void bar() {}\n}\n',
    lang: 'java', createdBy: 'test', resolveOne: stubResolve,
  });
  assert.equal(f.edges.filter(e => e.relation === 'imports').length, 1);
  const decls = f.nodes.filter(n => n.source.type === 'symbol').map(n => n.label);
  assert.ok(decls.includes('Foo'));
});

test('CSS: @import resolution', () => {
  const f = extractMultiLang({
    relPath: 'main.scss', fullPath: '/x/main.scss',
    body: '@import "./partial";\n@import url("vendor.css");\n.btn { color: red; }',
    lang: 'css', createdBy: 'test', resolveOne: stubResolve,
  });
  assert.equal(f.edges.filter(e => e.relation === 'imports').length, 2);
});

test('Ruby: require + class + def', () => {
  const f = extractMultiLang({
    relPath: 'a.rb', fullPath: '/x/a.rb',
    body: 'require "json"\nclass Foo\n  def bar; end\nend',
    lang: 'ruby', createdBy: 'test', resolveOne: stubResolve,
  });
  assert.equal(f.edges.filter(e => e.relation === 'imports').length, 1);
  const decls = f.nodes.filter(n => n.source.type === 'symbol').map(n => n.label);
  assert.ok(decls.some(d => d === 'Foo' || d === 'bar()'));
});

test('Swift: import + class + func', () => {
  const f = extractMultiLang({
    relPath: 'A.swift', fullPath: '/x/A.swift',
    body: 'import Foundation\npublic class Server {}\nfunc start() {}',
    lang: 'swift', createdBy: 'test', resolveOne: stubResolve,
  });
  assert.equal(f.edges.filter(e => e.relation === 'imports').length, 1);
  const decls = f.nodes.filter(n => n.source.type === 'symbol').map(n => n.label);
  assert.ok(decls.includes('Server'));
});
