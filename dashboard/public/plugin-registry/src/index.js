// plugin-registry -- the "Browse plugins" registry modal: list/filter, install
// from registry, install-from-folder, update, uninstall, and per-plugin
// settings save. Split out of the old parts/browser-credentials.js. esbuild
// IIFE; renderRegistryList and markRegistryNeedsRestart stay private. Reads the
// shared `state` at top level, so it loads AFTER app.js. Runtime deps resolve
// via window: state, esc, toast, and restartApp (startup part). See
// ARCHITECTURE.md.
state._registryPlugins = [];
state._pluginRecommendations = {};
async function loadPluginRecommendations() {
  try {
    var res = await fetch('/api/plugins/recommendations', {
      cache: 'no-store'
    });
    var data = await res.json();
    state._pluginRecommendations = {};
    (data.recommendations || []).forEach(function (r) {
      state._pluginRecommendations[r.id] = r;
    });
  } catch (_) {
    state._pluginRecommendations = {};
  }
  return state._pluginRecommendations;
}
function sortPluginsWithRecommendations(plugins, recommendations) {
  recommendations = recommendations || {};
  return (plugins || []).slice().sort(function (a, b) {
    var ar = recommendations[a.id] || null;
    var br = recommendations[b.id] || null;
    var as = ar && !a.installed ? ar.score || 0 : 0;
    var bs = br && !b.installed ? br.score || 0 : 0;
    if (as !== bs) return bs - as;
    return (a.name || a.id || '').localeCompare(b.name || b.id || '');
  });
}
async function browsePlugins() {
  document.getElementById('registryModal').classList.add('open');
  document.getElementById('registrySearch').value = '';
  document.getElementById('registryFilter').value = '';
  state._registryNeedsRestart = false;
  var closeBtn = document.getElementById('registryCloseBtn');
  if (closeBtn) {
    closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'background:none;border:none;color:var(--subtext0);cursor:pointer;padding:4px;display:flex;';
  }
  document.getElementById('registryList').innerHTML = '<div style="text-align:center;padding:40px;color:var(--subtext0);font-size:12px;">Loading registry...</div>';
  try {
    var recPromise = loadPluginRecommendations();
    var res = await fetch('/api/plugins/registry');
    var data = await res.json();
    await recPromise;
    if (data.error) {
      document.getElementById('registryList').innerHTML = '<div style="padding:20px;color:var(--red);font-size:12px;">Error: ' + data.error + '</div>';
      return;
    }
    state._registryPlugins = data.plugins || [];
    filterRegistry();
  } catch (e) {
    document.getElementById('registryList').innerHTML = '<div style="padding:20px;color:var(--red);font-size:12px;">Failed to load: ' + e.message + '</div>';
  }
}
state._registryNeedsRestart = false;
function markRegistryNeedsRestart() {
  state._registryNeedsRestart = true;
  var btn = document.getElementById('registryCloseBtn');
  if (!btn) return;
  btn.innerHTML = 'Save & Restart';
  btn.title = 'Restart the app to apply plugin changes';
  btn.style.cssText = 'font-size:12px;padding:4px 14px;background:var(--accent);color:var(--crust);border:1px solid var(--accent);border-radius:var(--radius);cursor:pointer;font-weight:600;font-family:var(--font-ui);';
}
function closeRegistryModal() {
  if (state._registryNeedsRestart) {
    state._registryNeedsRestart = false;
    document.getElementById('registryModal').classList.remove('open');
    toast('Restarting to apply plugin changes...', 'success');
    setTimeout(function () {
      restartApp();
    }, 500);
    return;
  }
  document.getElementById('registryModal').classList.remove('open');
}
function filterRegistry() {
  var q = (document.getElementById('registrySearch').value || '').toLowerCase();
  var filter = document.getElementById('registryFilter').value;
  var visible = state._registryPlugins.filter(function (p) {
    if (q && p.name.toLowerCase().indexOf(q) === -1 && p.description.toLowerCase().indexOf(q) === -1 && !(p.tags || []).some(function (t) {
      return t.toLowerCase().indexOf(q) !== -1;
    })) return false;
    if (filter === 'installed' && !p.installed) return false;
    if (filter === 'available' && p.installed) return false;
    if (filter === 'updates' && !p.updateAvailable) return false;
    return true;
  });
  visible = sortPluginsWithRecommendations(visible, state._pluginRecommendations);
  document.getElementById('registryCount').textContent = visible.length + ' of ' + state._registryPlugins.length + ' plugins';
  renderRegistryList(visible);
}
function renderRegistryList(plugins) {
  if (!plugins.length) {
    document.getElementById('registryList').innerHTML = '<div style="text-align:center;padding:40px;color:var(--subtext0);font-size:13px;">No plugins match your search</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    var borderColor = p.tint ? 'rgba(' + p.tint + ',0.4)' : 'var(--surface1)';
    html += '<div style="background:var(--surface0);border:1px solid ' + borderColor + ';border-radius:var(--radius-lg);padding:14px 16px;margin-bottom:8px;">';
    html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">';
    html += '<span style="font-size:15px;font-weight:600;">' + esc(p.name) + '</span>';
    html += '<span style="font-size:10px;color:var(--subtext0);background:var(--surface1);padding:1px 6px;border-radius:3px;">v' + esc(p.version) + '</span>';
    var rec = state._pluginRecommendations[p.id];
    if (rec && !p.installed) {
      html += '<span style="font-size:10px;color:var(--green);background:rgba(166,227,161,0.1);padding:1px 6px;border-radius:3px;">Recommended</span>';
    }
    if (p.updateAvailable) {
      html += '<span style="font-size:10px;color:var(--yellow);background:rgba(249,206,108,0.1);padding:1px 6px;border-radius:3px;">v' + esc(p.installedVersion) + ' installed</span>';
    }
    html += '</div>';
    html += '<div style="font-size:12px;color:var(--subtext1);line-height:1.5;margin-bottom:8px;">' + esc(p.description) + '</div>';
    if (rec && rec.reasons && rec.reasons.length) {
      html += '<div style="font-size:11px;color:var(--green);margin:-2px 0 8px;">' + esc(rec.reasons[0]) + '</div>';
    }
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<span style="font-size:10px;color:var(--overlay1);">by ' + esc(p.author) + '</span>';
    if (p.tags && p.tags.length) {
      p.tags.forEach(function (t) {
        html += '<span style="font-size:9px;padding:1px 6px;border-radius:99px;background:var(--surface1);color:var(--subtext0);">' + esc(t) + '</span>';
      });
    }
    html += '<div style="flex:1;"></div>';
    if (p.installed && p.updateAvailable) {
      var btnBg = p.tint ? 'rgba(' + p.tint + ',0.15)' : 'var(--surface1)';
      var btnColor = p.tint ? 'rgb(' + p.tint + ')' : 'var(--text)';
      var btnBorder = p.tint ? 'rgba(' + p.tint + ',0.3)' : 'var(--overlay0)';
      html += '<button onclick="updatePlugin(\'' + esc(p.id) + '\',\'' + esc(p.repo) + '\',\'' + esc(p.name) + '\')" style="font-size:11px;padding:4px 14px;background:' + btnBg + ';color:' + btnColor + ';border:1px solid ' + btnBorder + ';border-radius:var(--radius);cursor:pointer;font-weight:600;font-family:var(--font-ui);">Update</button>';
    } else if (p.installed) {
      html += '<span style="font-size:11px;color:var(--green);font-weight:600;display:flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Installed</span>';
    } else {
      var btnBg = p.tint ? 'rgba(' + p.tint + ',0.15)' : 'var(--surface1)';
      var btnColor = p.tint ? 'rgb(' + p.tint + ')' : 'var(--text)';
      var btnBorder = p.tint ? 'rgba(' + p.tint + ',0.3)' : 'var(--overlay0)';
      html += '<button onclick="installFromRegistry(\'' + esc(p.id) + '\',\'' + esc(p.repo) + '\',\'' + esc(p.name) + '\')" style="font-size:11px;padding:4px 14px;background:' + btnBg + ';color:' + btnColor + ';border:1px solid ' + btnBorder + ';border-radius:var(--radius);cursor:pointer;font-weight:600;font-family:var(--font-ui);">Install</button>';
    }
    html += '</div>';
    html += '</div>';
  }
  document.getElementById('registryList').innerHTML = html;
}
async function installFromRegistry(id, repo, name) {
  if (!confirm('Install "' + name + '" plugin?')) return;
  try {
    var res = await fetch('/api/plugins/install-from-registry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: id,
        repo: repo
      })
    });
    var data = await res.json();
    if (data.ok) {
      toast('Plugin "' + name + '" installed.', 'success');
      markRegistryNeedsRestart();
      // Refresh registry to show "Installed"
      var r = await fetch('/api/plugins/registry');
      var d = await r.json();
      state._registryPlugins = d.plugins || [];
      filterRegistry();
    } else {
      toast(data.error || 'Install failed', 'error');
    }
  } catch (e) {
    toast('Install failed: ' + e.message, 'error');
  }
}
async function updatePlugin(id, repo, name) {
  if (!confirm('Update "' + name + '"? Your settings will be preserved.')) return;
  try {
    var res = await fetch('/api/plugins/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: id,
        repo: repo
      })
    });
    var data = await res.json();
    if (data.ok) {
      toast('Plugin "' + name + '" updated.', 'success');
      markRegistryNeedsRestart();
      var r = await fetch('/api/plugins/registry');
      var d = await r.json();
      state._registryPlugins = d.plugins || [];
      filterRegistry();
    } else {
      toast(data.error || 'Update failed', 'error');
    }
  } catch (e) {
    toast('Update failed: ' + e.message, 'error');
  }
}
async function installPluginPrompt() {
  try {
    var browse = await fetch('/api/browse-folder', {
      method: 'POST'
    });
    var result = await browse.json();
    if (result.canceled || !result.path) return;
    var res = await fetch('/api/plugins/install', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path: result.path
      })
    });
    var data = await res.json();
    if (data.ok) {
      toast('Plugin "' + data.name + '" installed.', 'success');
      markRegistryNeedsRestart();
    } else {
      toast(data.error || 'Install failed', 'error');
    }
  } catch (e) {
    toast('Install failed', 'error');
  }
}

// Save plugin settings (called from saveSettings)
async function uninstallPlugin(id, name) {
  if (!confirm('Uninstall "' + name + '"? This will delete the plugin folder. You will need to restart the app.')) return;
  // Second prompt: keep the plugin's configuration for next install, or wipe
  // it so the next install is clean. OK = KEEP, Cancel = DELETE.
  var keepConfig = confirm('Keep "' + name + '" configuration for next install?\n\n' + 'OK = keep (next install will be pre-configured)\n' + 'Cancel = delete (next install will be clean)');
  try {
    var res = await fetch('/api/plugins/uninstall', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: id,
        keepConfig: keepConfig
      })
    });
    var data = await res.json();
    if (data.ok) {
      toast(name + ' uninstalled' + (keepConfig ? ' (config kept)' : '') + '. Restart to apply.', 'success');
      // Mark settings as needing restart
      var settingsBtn = document.getElementById('settingsSaveBtn');
      if (settingsBtn) {
        settingsBtn.textContent = 'Save & Restart';
        settingsBtn._needsRestart = true;
      }
      // Also mark registry modal if open
      if (document.getElementById('registryModal').classList.contains('open')) markRegistryNeedsRestart();
    } else {
      toast('Failed: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
}
async function savePluginSettings() {
  var inputs = document.querySelectorAll('.plugin-setting-input');
  var byPlugin = {};
  inputs.forEach(function (el) {
    if (el.disabled) return;
    var pid = el.dataset.plugin;
    var key = el.dataset.key;
    if (!pid || !key) return;
    if (el.classList.contains('plugin-setting-bool') || el.type === 'checkbox') {
      // Always persist booleans -- empty value would falsely flip the toggle off.
      if (!byPlugin[pid]) byPlugin[pid] = {};
      byPlugin[pid][key] = !!el.checked;
      return;
    }
    var val = (el.value || '').trim();
    if (!val) return; // skip empty (don't overwrite with blank)
    if (!byPlugin[pid]) byPlugin[pid] = {};
    byPlugin[pid][key] = val;
  });
  for (var pid in byPlugin) {
    try {
      await fetch('/api/plugins/' + pid + '/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(byPlugin[pid])
      });
    } catch (_) {}
  }
}

// ── Public surface ──────────────────────────────────────────────────────────
// Reached from index.html (browse/close/filter/installPrompt), generated
// onclick (install/update), onboarding.js (load/sort recommendations),
// plugins.js (uninstall), and settings.js (savePluginSettings).
// renderRegistryList + markRegistryNeedsRestart stay private.
window.loadPluginRecommendations = loadPluginRecommendations;
window.sortPluginsWithRecommendations = sortPluginsWithRecommendations;
window.browsePlugins = browsePlugins;
window.closeRegistryModal = closeRegistryModal;
window.filterRegistry = filterRegistry;
window.installFromRegistry = installFromRegistry;
window.updatePlugin = updatePlugin;
window.installPluginPrompt = installPluginPrompt;
window.uninstallPlugin = uninstallPlugin;
window.savePluginSettings = savePluginSettings;