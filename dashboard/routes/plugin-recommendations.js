'use strict';
// Plugin recommendations - inspects configured repos' git remotes (local only,
// no network) and suggests matching plugins. Extracted from server.js.
//
// ctx: { getConfig, getUiContext, pluginsDir, getPlugins }

const fs = require('fs');
const path = require('path');
const { gitSync } = require('../utils/git-async');
const { checkActivation } = require('../plugins-core/plugin-loader');

function mountPluginRecommendations(addRoute, json, ctx) {
  const { getConfig, getUiContext, pluginsDir, getPlugins } = ctx;

  function getPluginRecommendations() {
    const cfg = getConfig();
    const repos = cfg.Repos || {};
    const uiCtx = getUiContext ? getUiContext() : {};
    const repoEntries = [];
    if (uiCtx.activeRepo && repos[uiCtx.activeRepo]) repoEntries.push([uiCtx.activeRepo, repos[uiCtx.activeRepo]]);
    for (const entry of Object.entries(repos)) {
      if (!repoEntries.some(([name]) => name === entry[0])) repoEntries.push(entry);
    }

    const remotes = [];
    for (const [repoName, repoPath] of repoEntries.slice(0, 20)) {
      if (!repoPath || !fs.existsSync(repoPath)) continue;
      const out = gitSync(repoPath, 'remote -v', 5000);
      if (out) remotes.push({ repoName, text: out.toLowerCase() });
    }

    const installedIds = new Set();
    try {
      if (fs.existsSync(pluginsDir)) {
        for (const dir of fs.readdirSync(pluginsDir)) {
          if (dir !== 'sdk' && fs.existsSync(path.join(pluginsDir, dir, 'plugin.json'))) installedIds.add(dir);
        }
      }
    } catch (_) {}
    const activeIds = new Set((getPlugins ? getPlugins() : []).filter(p => checkActivation(p, getConfig)).map(p => p.id));
    const byId = new Map();
    const add = (id, label, reason, repoName, score) => {
      const item = byId.get(id) || { id, label, reasons: [], repoNames: [], score: 0, installed: installedIds.has(id), configured: activeIds.has(id) };
      if (reason && !item.reasons.includes(reason)) item.reasons.push(reason);
      if (repoName && !item.repoNames.includes(repoName)) item.repoNames.push(repoName);
      item.score = Math.max(item.score, score || 0);
      byId.set(id, item);
    };

    for (const r of remotes) {
      if (r.text.includes('github.com')) {
        add('github', 'GitHub', `Detected a GitHub remote in ${r.repoName}.`, r.repoName, 100);
      }
      if (r.text.includes('dev.azure.com') || r.text.includes('visualstudio.com')) {
        add('azure-devops', 'Azure DevOps', `Detected an Azure DevOps remote in ${r.repoName}.`, r.repoName, 95);
      }
    }

    return {
      recommendations: [...byId.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)),
      scannedRepos: repoEntries.length,
    };
  }

  addRoute('GET', '/api/plugins/recommendations', (req, res) => json(res, getPluginRecommendations()));
}

module.exports = { mountPluginRecommendations };
