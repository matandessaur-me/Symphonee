'use strict';
// Config store - the merge/normalize infrastructure behind getConfig().
// Effective config = template <- root config.json <- each plugin's config.json.
// Plugin-owned keys are written back into the owning plugin's config.json so the
// root config stays free of plugin secrets/state.
//
// Factory keeps paths injected so it stays testable and free of module globals.

const fs = require('fs');
const path = require('path');

const LEGACY_ROOT_CONFIG_KEYS = [
  'YoloMode',
  'YoloCliList',
  'GemmaEnabled',
  'GemmaModel',
  'GemmaOllamaHost',
  'GemmaOllamaPort',
];

function createConfigStore({ templatePath, configPath, pluginsDir }) {
  // getConfig() is called on (nearly) every API request. Reading + JSON-parsing
  // the template, the root config, and every plugin config.json on each call is
  // wasteful. Cache the merged result and invalidate by source-file mtimes, so a
  // config edit (from the UI, a plugin, or by hand) is still picked up at once
  // without serving stale data.
  let _cache = null;        // last merged config
  let _cacheSig = null;     // mtime signature the cache was built from

  // Cheap freshness fingerprint: dir-listing + mtime of every config source.
  // statSync is far cheaper than read+parse, and changes flip the signature.
  function sourceSignature() {
    const parts = [];
    for (const p of [templatePath, configPath]) {
      try { parts.push(p + ':' + fs.statSync(p).mtimeMs); } catch (_) { parts.push(p + ':0'); }
    }
    try {
      if (fs.existsSync(pluginsDir)) {
        for (const dir of fs.readdirSync(pluginsDir).sort()) {
          if (dir === 'sdk') continue;
          const cfgFile = path.join(pluginsDir, dir, 'config.json');
          try { parts.push(cfgFile + ':' + fs.statSync(cfgFile).mtimeMs); } catch (_) {}
        }
      }
    } catch (_) {}
    return parts.join('|');
  }

  // Drop the cache so the next getConfig() rebuilds. Call after writing config.
  function invalidate() { _cache = null; _cacheSig = null; }

  function readAllPluginConfigs() {
    const merged = {};
    try {
      if (!fs.existsSync(pluginsDir)) return merged;
      for (const dir of fs.readdirSync(pluginsDir)) {
        if (dir === 'sdk') continue;
        const cfgFile = path.join(pluginsDir, dir, 'config.json');
        if (!fs.existsSync(cfgFile)) continue;
        try { Object.assign(merged, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch (_) {}
      }
    } catch (_) {}
    return merged;
  }

  function getConfig() {
    const sig = sourceSignature();
    if (_cache && sig === _cacheSig) return { ..._cache };
    let template = {};
    let root = {};
    try { template = JSON.parse(fs.readFileSync(templatePath, 'utf8')); } catch (_) {}
    try { root = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
    _cache = { ...template, ...root, ...readAllPluginConfigs() };
    _cacheSig = sig;
    return { ..._cache };
  }

  function getPluginConfigKeyMap() {
    const map = new Map();
    try {
      if (!fs.existsSync(pluginsDir)) return map;
      for (const dir of fs.readdirSync(pluginsDir)) {
        if (dir === 'sdk') continue;
        const manifestPath = path.join(pluginsDir, dir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { continue; }
        const keys = (manifest.contributions && manifest.contributions.configKeys) || [];
        for (const key of keys) {
          if (typeof key === 'string' && key) map.set(key, manifest.id || dir);
        }
      }
    } catch (_) {}
    return map;
  }

  function persistPluginConfigKeys(config) {
    const keyMap = getPluginConfigKeyMap();
    if (!keyMap.size) return config;
    const rootConfig = { ...config };
    const byPlugin = {};
    for (const [key, pluginId] of keyMap.entries()) {
      if (Object.prototype.hasOwnProperty.call(rootConfig, key)) {
        byPlugin[pluginId] = byPlugin[pluginId] || {};
        byPlugin[pluginId][key] = rootConfig[key];
        delete rootConfig[key];
      }
    }
    for (const [pluginId, pluginCfg] of Object.entries(byPlugin)) {
      try {
        const pluginDir = path.join(pluginsDir, pluginId);
        const cfgFile = path.join(pluginDir, 'config.json');
        if (!fs.existsSync(pluginDir)) continue;
        let existing = {};
        try { if (fs.existsSync(cfgFile)) existing = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) {}
        fs.writeFileSync(cfgFile, JSON.stringify({ ...existing, ...pluginCfg }, null, 2), 'utf8');
      } catch (_) {}
    }
    return rootConfig;
  }

  function normalizeRootConfig(config) {
    const rootConfig = persistPluginConfigKeys(config);
    for (const key of LEGACY_ROOT_CONFIG_KEYS) {
      delete rootConfig[key];
    }
    return rootConfig;
  }

  return { getConfig, invalidate, readAllPluginConfigs, getPluginConfigKeyMap, persistPluginConfigKeys, normalizeRootConfig };
}

module.exports = { createConfigStore, LEGACY_ROOT_CONFIG_KEYS };
