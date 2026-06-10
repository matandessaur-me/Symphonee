'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConfigStore } = require('./config-store');

function scaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-cfg-'));
  const cfgDir = path.join(root, 'config');
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, 'foo'), { recursive: true });
  const templatePath = path.join(cfgDir, 'config.template.json');
  const configPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(templatePath, JSON.stringify({ A: 1, Shared: 'template' }));
  fs.writeFileSync(configPath, JSON.stringify({ B: 2, Shared: 'root' }));
  fs.writeFileSync(path.join(pluginsDir, 'foo', 'plugin.json'), JSON.stringify({ id: 'foo', contributions: { configKeys: ['FooKey'] } }));
  fs.writeFileSync(path.join(pluginsDir, 'foo', 'config.json'), JSON.stringify({ FooKey: 'x' }));
  return { templatePath, configPath, pluginsDir };
}

test('getConfig merges template <- root <- plugin configs', () => {
  const s = createConfigStore(scaffold());
  const cfg = s.getConfig();
  assert.equal(cfg.A, 1, 'template key');
  assert.equal(cfg.B, 2, 'root key');
  assert.equal(cfg.Shared, 'root', 'root overrides template');
  assert.equal(cfg.FooKey, 'x', 'plugin key merged');
});

test('getConfig caches but stays fresh when a source file changes', () => {
  const paths = scaffold();
  const s = createConfigStore(paths);
  assert.equal(s.getConfig().B, 2, 'initial root value');
  // Rewrite root config with a newer mtime; cache must notice via mtime sig.
  const future = Date.now() / 1000 + 5;
  fs.writeFileSync(paths.configPath, JSON.stringify({ B: 99, Shared: 'root' }));
  fs.utimesSync(paths.configPath, future, future);
  assert.equal(s.getConfig().B, 99, 'picks up the edit without restart');
});

test('getConfig result is a copy (mutating it does not poison the cache)', () => {
  const s = createConfigStore(scaffold());
  const first = s.getConfig();
  first.A = 'tampered';
  assert.equal(s.getConfig().A, 1, 'cache unaffected by caller mutation');
});

test('invalidate() forces a rebuild', () => {
  const paths = scaffold();
  const s = createConfigStore(paths);
  assert.equal(s.getConfig().B, 2);
  // Same mtime (no utimes bump): without invalidate the cache could serve stale.
  fs.writeFileSync(paths.configPath, JSON.stringify({ B: 7, Shared: 'root' }));
  s.invalidate();
  assert.equal(s.getConfig().B, 7, 'rebuilt after invalidate');
});

test('getPluginConfigKeyMap maps declared keys to owning plugin', () => {
  const s = createConfigStore(scaffold());
  const map = s.getPluginConfigKeyMap();
  assert.equal(map.get('FooKey'), 'foo');
});

test('normalizeRootConfig moves plugin keys out + drops legacy keys', () => {
  const paths = scaffold();
  const s = createConfigStore(paths);
  const out = s.normalizeRootConfig({ B: 2, FooKey: 'new', YoloMode: true });
  assert.equal('FooKey' in out, false, 'plugin key stripped from root');
  assert.equal('YoloMode' in out, false, 'legacy key dropped');
  assert.equal(out.B, 2, 'root key kept');
  // plugin key persisted into the plugin's own config.json
  const pluginCfg = JSON.parse(fs.readFileSync(path.join(paths.pluginsDir, 'foo', 'config.json'), 'utf8'));
  assert.equal(pluginCfg.FooKey, 'new');
});
