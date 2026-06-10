'use strict';
// Repos + Spaces routes - extracted from server.js (behavior-preserving).
// Both manage entries inside the root config.json (Repos map, Spaces map).
//
// ctx: { getConfig, normalizeRootConfig, configPath, broadcast }

const fs = require('fs');
const { atomicWriteSync } = require('../utils/atomic-write');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const CORE_SPACE_PLUGIN_IDS = new Set(['browser-use', 'video-use', 'stagehand']);

function normalizeSpacePluginList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    if (CORE_SPACE_PLUGIN_IDS.has(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

function mountSpaces(addRoute, json, ctx) {
  const { getConfig, invalidateConfig, normalizeRootConfig, configPath, broadcast } = ctx;

  const readCfg = () => {
    try { return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}; } catch (_) { return {}; }
  };
  const writeCfg = (cfg) => {
    atomicWriteSync(configPath, JSON.stringify(normalizeRootConfig(cfg), null, 2));
    if (typeof invalidateConfig === 'function') invalidateConfig();
    broadcast({ type: 'config-changed' });
  };

  function handleGetRepos(res) {
    json(res, getConfig().Repos || {});
  }

  async function handleSaveRepo(req, res) {
    const { name, path: repoPath } = await readBody(req);
    if (!name || !repoPath) return json(res, { error: 'name and path are required' }, 400);
    const cfg = readCfg();
    cfg.Repos = cfg.Repos || {};
    cfg.Repos[name] = repoPath;
    writeCfg(cfg);
    json(res, { ok: true });
  }

  function handleGetSpaces(res) {
    json(res, getConfig().Spaces || {});
  }

  async function handleSaveSpace(req, res) {
    const body = await readBody(req);
    const { name, icon, description, repos, plugins } = body || {};
    if (!name) return json(res, { error: 'name is required' }, 400);
    const cfg = readCfg();
    cfg.Spaces = cfg.Spaces || {};
    const prev = cfg.Spaces[name] || {};
    cfg.Spaces[name] = {
      icon: icon || prev.icon || 'layers',
      description: description !== undefined ? description : (prev.description || ''),
      repos: Array.isArray(repos) ? repos.filter(r => typeof r === 'string') : (prev.repos || []),
      plugins: Array.isArray(plugins) ? normalizeSpacePluginList(plugins) : normalizeSpacePluginList(prev.plugins || []),
      createdAt: prev.createdAt || Date.now(),
    };
    writeCfg(cfg);
    json(res, { ok: true, space: cfg.Spaces[name] });
  }

  // Toggle whether a repo is a member of a space (single-space membership:
  // adding to one space removes it from any other).
  async function handleSpaceAttachRepo(req, res) {
    const { space, repo, attach } = await readBody(req);
    if (!space || !repo) return json(res, { error: 'space and repo are required' }, 400);
    const cfg = readCfg();
    cfg.Spaces = cfg.Spaces || {};
    if (!cfg.Spaces[space]) return json(res, { error: 'space not found' }, 404);
    for (const [n, s] of Object.entries(cfg.Spaces)) {
      if (!s || !Array.isArray(s.repos)) continue;
      cfg.Spaces[n] = { ...s, repos: s.repos.filter(r => r !== repo) };
    }
    if (attach !== false) {
      const s = cfg.Spaces[space];
      const list = Array.isArray(s.repos) ? s.repos : [];
      cfg.Spaces[space] = { ...s, repos: list.includes(repo) ? list : list.concat(repo) };
    }
    writeCfg(cfg);
    json(res, { ok: true });
  }

  // Toggle plugin presence in a space's preset.
  async function handleSpaceTogglePlugin(req, res) {
    const { space, plugin, enabled } = await readBody(req);
    if (!space || !plugin) return json(res, { error: 'space and plugin are required' }, 400);
    if (CORE_SPACE_PLUGIN_IDS.has(plugin)) return json(res, { ok: true, plugins: normalizeSpacePluginList(((getConfig().Spaces || {})[space] || {}).plugins || []) });
    const cfg = readCfg();
    cfg.Spaces = cfg.Spaces || {};
    if (!cfg.Spaces[space]) return json(res, { error: 'space not found' }, 404);
    const s = cfg.Spaces[space];
    const list = Array.isArray(s.plugins) ? s.plugins.slice() : [];
    const idx = list.indexOf(plugin);
    if (enabled === false || (enabled === undefined && idx >= 0)) {
      if (idx >= 0) list.splice(idx, 1);
    } else if (idx < 0) {
      list.push(plugin);
    }
    cfg.Spaces[space] = { ...s, plugins: normalizeSpacePluginList(list) };
    writeCfg(cfg);
    json(res, { ok: true, plugins: cfg.Spaces[space].plugins });
  }

  async function handleDeleteSpace(req, res) {
    const { name } = await readBody(req);
    if (!name) return json(res, { error: 'name is required' }, 400);
    const cfg = readCfg();
    if (cfg.Spaces && cfg.Spaces[name]) delete cfg.Spaces[name];
    writeCfg(cfg);
    json(res, { ok: true });
  }

  // ── Route registrations ─────────────────────────────────────────────────
  addRoute('GET',    '/api/repos',                (req, res) => handleGetRepos(res));
  addRoute('POST',   '/api/repos',                (req, res) => handleSaveRepo(req, res));
  addRoute('GET',    '/api/spaces',               (req, res) => handleGetSpaces(res));
  addRoute('POST',   '/api/spaces',               (req, res) => handleSaveSpace(req, res));
  addRoute('DELETE', '/api/spaces',               (req, res) => handleDeleteSpace(req, res));
  addRoute('POST',   '/api/spaces/attach-repo',   (req, res) => handleSpaceAttachRepo(req, res));
  addRoute('POST',   '/api/spaces/toggle-plugin', (req, res) => handleSpaceTogglePlugin(req, res));
}

module.exports = { mountSpaces };
