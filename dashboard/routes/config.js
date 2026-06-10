'use strict';
// Config + themes routes - extracted from server.js (behavior-preserving).
// The merge/normalize infra lives in lib/config-store (passed via ctx as
// getConfig + normalizeRootConfig).
//
// ctx: { getConfig, normalizeRootConfig, configPath, templatePath, repoRoot,
//        pluginsDir, swrGit, swrPlugins, broadcast, writePluginHints, getPlugins }

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteSync } = require('../utils/atomic-write');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const CORE_SENSITIVE_KEYS = ['AiApiKeys', 'BrowserCredentials'];

function mountConfig(addRoute, json, ctx) {
  const {
    getConfig, invalidateConfig, normalizeRootConfig, configPath, templatePath, repoRoot, pluginsDir,
    swrGit, swrPlugins, broadcast, writePluginHints, getPlugins,
  } = ctx;
  const themesPath = path.join(repoRoot, 'config', 'themes.json');
  const learningsDataDir = path.join(repoRoot, '.ai-workspace');

  // Sensitive fields to strip from exports (PATs, API keys).
  // Core owns only its own shell-level secrets; plugins contribute their own via
  // contributions.sensitiveKeys. This keeps core zero-coupled from ADO/GH/etc.
  function getSensitiveKeys() {
    const keys = new Set(CORE_SENSITIVE_KEYS);
    for (const p of (getPlugins ? getPlugins() : [])) {
      const c = (p.contributions || {});
      if (Array.isArray(c.sensitiveKeys)) for (const k of c.sensitiveKeys) if (typeof k === 'string') keys.add(k);
    }
    return [...keys];
  }

  function handleGetThemes(res) {
    try {
      const data = fs.existsSync(themesPath) ? JSON.parse(fs.readFileSync(themesPath, 'utf8')) : { themes: [], active: null };
      json(res, data);
    } catch (_) {
      json(res, { themes: [], active: null });
    }
  }

  async function handleSaveThemes(req, res) {
    const data = await readBody(req);
    try {
      fs.writeFileSync(themesPath, JSON.stringify(data, null, 2));
      json(res, { ok: true });
    } catch (e) {
      json(res, { ok: false, error: e.message }, 500);
    }
  }

  function handleGetConfig(res) {
    json(res, getConfig());
  }

  async function handleSaveConfig(req, res) {
    const incoming = await readBody(req);
    let template = {};
    try { template = JSON.parse(fs.readFileSync(templatePath, 'utf8')); } catch (_) {}
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
    const config = normalizeRootConfig({ ...template, ...existing, ...incoming });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    atomicWriteSync(configPath, JSON.stringify(config, null, 2));
    // Immediately clear all caches so the next request uses the new config.
    swrGit.clear(); swrPlugins.clear();
    if (typeof invalidateConfig === 'function') invalidateConfig();
    // Regenerate AI instructions (plugin set, orchestration, etc. may have changed)
    try { writePluginHints(); } catch (_) {}
    json(res, { ok: true });
  }

  function handleExportConfig(res) {
    const cfg = getConfig();
    // Strip machine-specific fields only (repos have local paths).
    // Secrets are kept: exports are for the user's own machine-to-machine transfer.
    const exportCfg = { ...cfg };
    delete exportCfg.Repos;
    exportCfg._exportedAt = new Date().toISOString();
    exportCfg._exportedFrom = 'Symphonee';
    // Collect plugin configs
    const pluginConfigs = {};
    try {
      const dirs = fs.readdirSync(pluginsDir);
      for (const dir of dirs) {
        if (dir === 'sdk') continue;
        const cfgFile = path.join(pluginsDir, dir, 'config.json');
        if (fs.existsSync(cfgFile)) {
          try {
            const pcfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
            pluginConfigs[dir] = pcfg;
          } catch (_) {}
        }
      }
    } catch (_) {}
    if (Object.keys(pluginConfigs).length) exportCfg._pluginConfigs = pluginConfigs;
    // Include custom themes
    try {
      if (fs.existsSync(themesPath)) {
        exportCfg._themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
      }
    } catch (_) {}
    // Include notes (markdown bodies keyed by filename without extension)
    try {
      const notesRoot = path.join(repoRoot, 'notes');
      if (fs.existsSync(notesRoot)) {
        const map = {};
        for (const f of fs.readdirSync(notesRoot)) {
          if (!f.endsWith('.md')) continue;
          try { map[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(notesRoot, f), 'utf8'); } catch (_) {}
        }
        if (Object.keys(map).length) exportCfg._notes = map;
      }
    } catch (_) {}
    // Include user-authored recipes (project-local + ~/.symphonee/recipes).
    try {
      const recipeMap = {};
      const dirs = [path.join(repoRoot, 'recipes'), path.join(os.homedir(), '.symphonee', 'recipes')];
      for (const d of dirs) {
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d)) {
          if (!f.endsWith('.md')) continue;
          try { recipeMap[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(d, f), 'utf8'); } catch (_) {}
        }
      }
      if (Object.keys(recipeMap).length) exportCfg._recipes = recipeMap;
    } catch (_) {}
    // Include learnings
    try {
      const lp = path.join(learningsDataDir, 'learnings.json');
      if (fs.existsSync(lp)) exportCfg._learnings = JSON.parse(fs.readFileSync(lp, 'utf8'));
    } catch (_) {}
    // Include display preferences (sidebar widths, collapsed state)
    try {
      const dp = path.join(repoRoot, 'config', 'display-pref.json');
      if (fs.existsSync(dp)) exportCfg._displayPref = JSON.parse(fs.readFileSync(dp, 'utf8'));
    } catch (_) {}
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="symphonee-settings.json"',
    });
    res.end(JSON.stringify(exportCfg, null, 2));
  }

  async function handleImportConfig(req, res) {
    const incoming = await readBody(req);
    if (!incoming || typeof incoming !== 'object') {
      return json(res, { error: 'Invalid settings file' }, 400);
    }
    // Remove export metadata and machine-specific fields
    delete incoming._exportedAt;
    delete incoming._exportedFrom;
    delete incoming.Repos;
    // Restore themes
    const importedThemes = incoming._themes;
    delete incoming._themes;
    if (importedThemes && typeof importedThemes === 'object') {
      try {
        fs.mkdirSync(path.dirname(themesPath), { recursive: true });
        fs.writeFileSync(themesPath, JSON.stringify(importedThemes, null, 2), 'utf8');
      } catch (_) {}
    }
    // Restore notes
    const importedNotes = incoming._notes;
    delete incoming._notes;
    if (importedNotes && typeof importedNotes === 'object') {
      try {
        const notesRoot = path.join(repoRoot, 'notes');
        fs.mkdirSync(notesRoot, { recursive: true });
        for (const [name, body] of Object.entries(importedNotes)) {
          const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
          const dest = path.join(notesRoot, safe + '.md');
          if (path.resolve(dest).startsWith(path.resolve(notesRoot))) {
            try { fs.writeFileSync(dest, String(body || ''), 'utf8'); } catch (_) {}
          }
        }
      } catch (_) {}
    }
    // Restore user recipes into ~/.symphonee/recipes (never overwrite shipped defaults).
    const importedRecipes = incoming._recipes;
    delete incoming._recipes;
    if (importedRecipes && typeof importedRecipes === 'object') {
      try {
        const shippedDir = path.join(repoRoot, 'recipes');
        const shipped = new Set();
        if (fs.existsSync(shippedDir)) {
          for (const f of fs.readdirSync(shippedDir)) {
            if (f.endsWith('.md')) shipped.add(f.replace(/\.md$/, ''));
          }
        }
        const userDir = path.join(os.homedir(), '.symphonee', 'recipes');
        fs.mkdirSync(userDir, { recursive: true });
        for (const [name, body] of Object.entries(importedRecipes)) {
          if (shipped.has(name)) continue;
          const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
          const dest = path.join(userDir, safe + '.md');
          if (path.resolve(dest).startsWith(path.resolve(userDir))) {
            try { fs.writeFileSync(dest, String(body || ''), 'utf8'); } catch (_) {}
          }
        }
      } catch (_) {}
    }
    // Restore learnings
    const importedLearnings = incoming._learnings;
    delete incoming._learnings;
    if (importedLearnings && typeof importedLearnings === 'object') {
      try {
        fs.mkdirSync(learningsDataDir, { recursive: true });
        fs.writeFileSync(path.join(learningsDataDir, 'learnings.json'), JSON.stringify(importedLearnings, null, 2), 'utf8');
      } catch (_) {}
    }
    // Restore display preferences
    const importedDisplayPref = incoming._displayPref;
    delete incoming._displayPref;
    if (importedDisplayPref && typeof importedDisplayPref === 'object') {
      try {
        const dp = path.join(repoRoot, 'config', 'display-pref.json');
        fs.mkdirSync(path.dirname(dp), { recursive: true });
        fs.writeFileSync(dp, JSON.stringify(importedDisplayPref, null, 2), 'utf8');
      } catch (_) {}
    }
    // Restore plugin configs (and auto-install missing plugins from registry).
    const pluginConfigs = incoming._pluginConfigs;
    delete incoming._pluginConfigs;
    const installedPlugins = [];
    if (pluginConfigs && typeof pluginConfigs === 'object') {
      const missingPluginIds = [];
      for (const pluginId of Object.keys(pluginConfigs)) {
        const pluginDir = path.join(pluginsDir, pluginId);
        if (fs.existsSync(pluginDir)) {
          try { fs.writeFileSync(path.join(pluginDir, 'config.json'), JSON.stringify(pluginConfigs[pluginId], null, 2), 'utf8'); } catch (_) {}
        } else {
          missingPluginIds.push(pluginId);
        }
      }
      if (missingPluginIds.length > 0) {
        try {
          const https = require('https');
          const REGISTRY_API_URL = 'https://api.github.com/repos/matandessaur-me/Symphonee-plugins/contents/registry.json';
          const raw = await new Promise((resolve, reject) => {
            https.get(REGISTRY_API_URL, { headers: { 'User-Agent': 'Symphonee', 'Accept': 'application/vnd.github.v3+json' } }, (resp) => {
              let d = '';
              resp.on('data', c => { d += c; });
              resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
            }).on('error', reject);
          });
          if (raw.content) {
            const registry = JSON.parse(Buffer.from(raw.content, 'base64').toString());
            const { spawnSync } = require('child_process');
            for (const pluginId of missingPluginIds) {
              const entry = (registry.plugins || []).find(p => p.id === pluginId);
              if (!entry || !entry.repo) continue;
              const destDir = path.join(pluginsDir, pluginId);
              try {
                const result = spawnSync('git', ['clone', entry.repo + '.git', destDir], {
                  encoding: 'utf8',
                  timeout: 60000,
                  stdio: ['pipe', 'pipe', 'pipe'],
                  windowsHide: true,
                  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                });
                if (result.error || result.status !== 0) throw new Error((result.stderr || result.stdout || (result.error && result.error.message) || 'git clone failed').trim());
                if (fs.existsSync(path.join(destDir, 'plugin.json'))) {
                  fs.writeFileSync(path.join(destDir, 'config.json'), JSON.stringify(pluginConfigs[pluginId], null, 2), 'utf8');
                  installedPlugins.push(pluginId);
                } else {
                  fs.rmSync(destDir, { recursive: true, force: true });
                }
              } catch (_) {
                try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }
      if (installedPlugins.length > 0 && typeof writePluginHints === 'function') writePluginHints();
    }
    // Merge with existing config; preserve sensitive values when the import omits them.
    const existing = getConfig();
    const merged = { ...existing, ...incoming };
    for (const key of getSensitiveKeys()) {
      if (!incoming[key] && existing[key]) merged[key] = existing[key];
    }
    const config = normalizeRootConfig(merged);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    atomicWriteSync(configPath, JSON.stringify(config, null, 2));
    swrGit.clear(); swrPlugins.clear();
    if (typeof invalidateConfig === 'function') invalidateConfig();
    broadcast({ type: 'config-changed' });
    const result = { ok: true };
    if (installedPlugins.length > 0) {
      result.pluginsInstalled = installedPlugins;
      result.restartRequired = true;
    }
    json(res, result);
  }

  // Wipe everything a clean install would not have. Caller must set { confirm: true }.
  async function handleFactoryReset(req, res) {
    const body = await readBody(req).catch(() => ({}));
    if (!body || body.confirm !== true) return json(res, { error: 'confirm:true required' }, 400);
    const rmIfExists = (p) => { try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
    // 1. Core state
    rmIfExists(configPath);
    rmIfExists(themesPath);
    rmIfExists(path.join(repoRoot, 'config', 'display-pref.json'));
    // 2. Notes + user recipes + learnings
    rmIfExists(path.join(repoRoot, 'notes'));
    rmIfExists(path.join(os.homedir(), '.symphonee', 'recipes'));
    rmIfExists(path.join(learningsDataDir, 'learnings.json'));
    // 3. Third-party plugins (keep only the SDK docs that ship from the main repo).
    const BUNDLED_PLUGIN_IDS = new Set(['sdk']);
    try {
      for (const d of fs.readdirSync(pluginsDir)) {
        if (BUNDLED_PLUGIN_IDS.has(d)) continue;
        rmIfExists(path.join(pluginsDir, d));
      }
    } catch (_) {}
    // 4. Also wipe each remaining plugin's config.json so bundled plugins come back blank
    try {
      for (const d of fs.readdirSync(pluginsDir)) {
        if (d === 'sdk') continue;
        rmIfExists(path.join(pluginsDir, d, 'config.json'));
      }
    } catch (_) {}
    // 5. Reset in-memory caches so subsequent requests don't serve stale values
    swrGit.clear(); swrPlugins.clear();
    json(res, { ok: true });
  }

  // ── Route registrations ─────────────────────────────────────────────────
  addRoute('GET',  '/api/themes',         (req, res) => handleGetThemes(res));
  addRoute('POST', '/api/themes',         (req, res) => handleSaveThemes(req, res));
  addRoute('GET',  '/api/config',         (req, res) => handleGetConfig(res));
  addRoute('POST', '/api/config',         (req, res) => handleSaveConfig(req, res));
  addRoute('GET',  '/api/config/export',  (req, res) => handleExportConfig(res));
  addRoute('POST', '/api/config/import',  (req, res) => handleImportConfig(req, res));
  addRoute('POST', '/api/config/reset',   (req, res) => handleFactoryReset(req, res));
}

module.exports = { mountConfig };
