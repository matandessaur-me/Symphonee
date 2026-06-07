// ── Create Work Item Modal ──────────────────────────────────────────────
function openCreateModal(type) {
  document.getElementById('createType').value = type || 'User Story';
  document.getElementById('createModalTitle').textContent = 'New Work Item';
  document.getElementById('createTitle').value = '';
  document.getElementById('createDesc').value = '';
  document.getElementById('createAC').value = '';
  document.getElementById('createPoints').value = '';
  document.getElementById('createTags').value = '';
  document.getElementById('createModal').classList.add('open');
  document.getElementById('createTitle').focus();
  // Load team members for assign dropdown
  loadTeamMembers();
}
function closeCreateModal() {
  document.getElementById('createModal').classList.remove('open');
}
async function submitCreateWorkItem() {
  const body = {
    type: document.getElementById('createType').value,
    title: document.getElementById('createTitle').value,
    description: document.getElementById('createDesc').value,
    acceptanceCriteria: document.getElementById('createAC').value,
    priority: document.getElementById('createPriority').value,
    storyPoints: document.getElementById('createPoints').value,
    assignedTo: document.getElementById('createAssign').value,
    tags: document.getElementById('createTags').value,
    iterationPath: document.getElementById('sprintSelect').value
  };
  if (!body.title) {
    toast('Title is required', 'error');
    return;
  }
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'createRoute', {
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    }));
    if (!res) {
      toast('No work item provider installed', 'error');
      return;
    }
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    toast(`Created #${data.id}: ${data.title}`, 'success');
    closeCreateModal();
    loadWorkItems(true);
  } catch (e) {
    toast('Failed to create work item', 'error');
  }
}

// ── AI Tools Detection & Install ─────────────────────────────────────────
const AI_TOOLS_META = {
  claude: {
    name: 'Claude Code',
    color: '#d97757',
    pkg: '@anthropic-ai/claude-code',
    docs: 'https://docs.anthropic.com/en/docs/claude-code'
  },
  gemini: {
    name: 'Gemini CLI',
    color: '#078efa',
    pkg: '@google/gemini-cli',
    docs: 'https://github.com/google-gemini/gemini-cli'
  },
  copilot: {
    name: 'Copilot CLI',
    color: '#8534f3',
    pkg: '@github/copilot',
    docs: 'https://www.npmjs.com/package/@github/copilot'
  },
  codex: {
    name: 'Codex CLI',
    color: '#10a37f',
    pkg: '@openai/codex',
    docs: 'https://github.com/openai/codex'
  },
  grok: {
    name: 'Grok Code',
    color: '#ef4444',
    pkg: '@webdevtoday/grok-cli',
    docs: 'https://github.com/superagent-ai/grok-cli'
  },
  qwen: {
    name: 'Qwen Code',
    color: '#615ced',
    pkg: '@qwen-code/qwen-code',
    docs: 'https://github.com/QwenLM/qwen-code'
  }
};
state._aiToolsStatus = {}; // cli -> { installed, path }
state._pwshStatus = {
  installed: false
}; // CLI ids whose install is currently in-flight. Kept in the model (not just on
// the button) so a full renderAiTools() re-render -- triggered when a SIBLING
// install finishes -- does not reset a still-installing tool back to "Install".
const _aiInstalling = new Set();
async function detectAiTools() {
  const container = document.getElementById('settingsAiTools');
  container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);">Detecting installed AI CLIs...</div>';
  try {
    const res = await fetch('/api/prerequisites');
    const data = await res.json();
    state._aiToolsStatus = data.cliTools || {};
    state._pwshStatus = data.pwsh || {
      installed: false
    };
    renderAiTools();
  } catch (e) {
    container.innerHTML = '<div style="font-size:11px;color:var(--red);">Failed to detect AI tools</div>';
  }
}
function renderAiTools() {
  const container = document.getElementById('settingsAiTools');

  // PowerShell 7 prerequisite card
  const pwshInstalled = state._pwshStatus.installed;
  const pwshInstalling = _aiInstalling.has('pwsh');
  const pwshBtn = pwshInstalling ? `<button class="ai-tool-btn installing" id="aiToolBtn-pwsh" disabled>Installing...</button>` : `<button class="ai-tool-btn ${pwshInstalled ? 'installed' : 'install'}" id="aiToolBtn-pwsh"
                onclick="${pwshInstalled ? '' : "installCli('pwsh')"}"
                ${pwshInstalled ? 'disabled' : ''}>${pwshInstalled ? 'Installed' : 'Install'}</button>`;
  const pwshCard = `
    <div style="margin-bottom:8px;padding:0 2px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--subtext0);margin-bottom:6px;">Prerequisites</div>
      <div class="ai-tool-card" id="aiToolCard-pwsh" style="${pwshInstalled ? '' : 'border-color:var(--yellow);'}">
        <div class="ai-tool-dot" style="background:var(--blue)"></div>
        <div class="ai-tool-info">
          <div class="ai-tool-name">PowerShell 7</div>
          ${pwshInstalled ? '<span class="ai-tool-status installed">Installed</span>' : '<span class="ai-tool-status not-installed" style="color:var(--yellow);">Required for AI CLI tools</span>'}
        </div>
        ${pwshBtn}
      </div>
    </div>
    <div style="padding:0 2px;margin-bottom:6px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--subtext0);">AI Tools</div>
    </div>`;

  // AI tool cards
  const toolCards = Object.entries(AI_TOOLS_META).map(([id, meta]) => {
    const status = state._aiToolsStatus[id] || {
      installed: false
    };
    const isInstalled = status.installed;
    const isInstalling = _aiInstalling.has(id);
    const statusText = isInstalled ? `<span class="ai-tool-status installed">Installed</span>` : `<span class="ai-tool-status not-installed">Not installed &middot; <code style="font-size:9px;color:var(--subtext0);">npm i -g ${meta.pkg}</code></span>`;

    // In-progress installs win over the installed/not-installed state so a
    // re-render (e.g. a sibling install finishing) keeps showing "Installing...".
    const btn = isInstalling ? `<button class="ai-tool-btn installing" id="aiToolBtn-${id}" disabled>Installing...</button>` : `<button class="ai-tool-btn ${isInstalled ? 'installed' : 'install'}" id="aiToolBtn-${id}"
                onclick="${isInstalled ? '' : `installCli('${id}')`}"
                ${isInstalled ? 'disabled' : ''}>${isInstalled ? 'Installed' : 'Install'}</button>`;
    return `
      <div class="ai-tool-card" id="aiToolCard-${id}">
        <div class="ai-tool-dot" style="background:${meta.color}"></div>
        <div class="ai-tool-info">
          <div class="ai-tool-name">${meta.name}</div>
          ${statusText}
        </div>
        ${btn}
      </div>`;
  }).join('');
  container.innerHTML = pwshCard + toolCards;
}
async function installCli(cli) {
  const btn = document.getElementById(`aiToolBtn-${cli}`);
  if (!btn) return;
  _aiInstalling.add(cli);
  btn.className = 'ai-tool-btn installing';
  btn.textContent = 'Installing...';
  btn.disabled = true;
  // Clear any previous fallback hint
  const prevHint = btn.closest('.ai-tool-card')?.querySelector('.install-fallback-hint');
  if (prevHint) prevHint.remove();
  try {
    const res = await fetch('/api/cli/install', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cli
      })
    });
    const data = await res.json();
    const displayName = cli === 'pwsh' ? 'PowerShell 7' : AI_TOOLS_META[cli]?.name || cli;
    if (data.ok && data.installed) {
      if (cli === 'pwsh') {
        state._pwshStatus = {
          installed: true,
          path: data.path
        };
      } else {
        state._aiToolsStatus[cli] = {
          installed: true,
          path: data.path
        };
      }
      if (data.needsRestart) {
        toast(`${displayName} installed! Restart the app so the terminal can use it.`, 'success');
      } else {
        toast(`${displayName} installed successfully`, 'success');
      }
      _aiInstalling.delete(cli);
      renderAiTools();
    } else {
      _aiInstalling.delete(cli);
      btn.className = 'ai-tool-btn install';
      btn.textContent = 'Retry';
      btn.disabled = false;
      const errMsg = data.error || 'Unknown error';
      toast(`Failed to install ${displayName}: ${errMsg}`, 'error');
      if (data.fallbackCmd) {
        showInstallFallbackHint(btn, data.fallbackCmd, errMsg);
      }
    }
  } catch (e) {
    _aiInstalling.delete(cli);
    btn.className = 'ai-tool-btn install';
    btn.textContent = 'Retry';
    btn.disabled = false;
    toast(`Install failed: ${e.message}`, 'error');
  }
}

// ── Settings Modal ──────────────────────────────────────────────────────
function switchSettingsTab(tabId, btn) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'));
  const tab = document.getElementById(`settingsTab-${tabId}`);
  if (tab) tab.classList.add('active');
  if (btn) btn.classList.add('active');
  // Trigger AI detection when switching to AI tab
  if (tabId === 'ai') detectAiTools();
  if (tabId === 'theme') renderThemeList();
  if (tabId === 'hotkeys') {
    try {
      renderHotkeys();
    } catch (_) {}
  }
  if (tabId === 'repos') {
    try {
      renderSettingsSpaces();
    } catch (_) {}
  }
  // Semi-transparent overlay on theme tab so user can preview live
  const modal = document.getElementById('settingsModal');
  if (modal) modal.classList.toggle('theme-preview', tabId === 'theme');
}
function openSettings(tab) {
  document.getElementById('settingsOrg').value = state.configData.AzureDevOpsOrg || '';
  document.getElementById('settingsPAT').value = state.configData.AzureDevOpsPAT || '';
  document.getElementById('settingsUser').value = state.configData.DefaultUser || '';
  document.getElementById('settingsGitHubPAT').value = state.configData.GitHubPAT || '';
  const continuousEl = document.getElementById('settingsEnableContinuousLearning');
  if (continuousEl) continuousEl.checked = state.configData.EnableContinuousLearning === true;
  refreshSmartSearchStatus();
  // AI API keys
  const aiKeys = state.configData.AiApiKeys || {};
  document.getElementById('settingsOpenaiKey').value = aiKeys.OPENAI_API_KEY || '';
  document.getElementById('settingsGeminiKey').value = aiKeys.GEMINI_API_KEY || '';
  document.getElementById('settingsAnthropicKey').value = aiKeys.ANTHROPIC_API_KEY || '';
  document.getElementById('settingsXaiKey').value = aiKeys.XAI_API_KEY || '';
  renderBrowserCreds();
  // Populate orchestrator CLI checkboxes
  var orchList = Array.isArray(state.configData.OrchestrateCliList) ? state.configData.OrchestrateCliList : ['claude', 'gemini', 'codex', 'copilot', 'grok', 'qwen'];
  document.querySelectorAll('.orch-cli-cb').forEach(function (cb) {
    cb.checked = orchList.includes(cb.value);
  });
  document.getElementById('settingsDefaultCli').value = state.configData.DefaultCli || state.activeCli || 'claude';
  document.getElementById('settingsTeam').value = state.configData.DefaultTeam || '';
  // Initialize projects list from config
  const rawProjects = Array.isArray(state.configData.AzureDevOpsProjects) ? state.configData.AzureDevOpsProjects : [];
  state._settingsProjects = rawProjects.map(p => typeof p === 'object' ? p.name : p);
  state._settingsActiveProject = state.configData.AzureDevOpsProject || '';
  // Migration: if there's an active project not in the list, add it
  if (state._settingsActiveProject && !state._settingsProjects.includes(state._settingsActiveProject)) {
    state._settingsProjects.unshift(state._settingsActiveProject);
  }
  renderSettingsProjects();
  renderSettingsRepos();
  // Reset to requested tab. Default = first visible nav button (usually 'ai' now that 'ado' is gone).
  const firstVisibleBtn = Array.from(document.querySelectorAll('.settings-nav-btn')).find(b => b.offsetParent !== null && b.style.display !== 'none');
  const targetTab = tab || firstVisibleBtn && firstVisibleBtn.dataset.settingsTab || 'ai';
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'));
  const targetPanel = document.getElementById(`settingsTab-${targetTab}`);
  if (targetPanel) targetPanel.classList.add('active');
  const navBtn = document.querySelector(`.settings-nav-btn[data-settings-tab="${targetTab}"]`);
  if (navBtn) navBtn.classList.add('active');
  const settingsModal = document.getElementById('settingsModal');
  settingsModal.classList.add('open');
  settingsModal.classList.toggle('theme-preview', targetTab === 'theme');
  // Trigger any per-tab lazy loaders for the initially-shown tab. Previously only
  // switchSettingsTab did this, so opening straight onto "AI Tools" (the default)
  // showed an empty panel until the user tabbed away and back.
  if (targetTab === 'ai') detectAiTools();
  if (targetTab === 'theme') renderThemeList();
  try {
    lucide.createIcons();
  } catch (_) {}
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
  // Revert unsaved theme editor changes
  if (state._themeEditorDirty) {
    state._themeEditorDirty = false;
    const status = document.getElementById('themeEditorStatus');
    if (status) status.style.display = 'none';
    // Clear inline custom vars and restore the real theme
    ALL_CSS_KEYS.forEach(k => document.documentElement.style.removeProperty(k));
    restoreCustomTheme();
  }
}
state._settingsProjects = [];
state._settingsActiveProject = '';
function renderSettingsProjects() {
  const container = document.getElementById('settingsProjectList');
  if (!state._settingsProjects.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:4px 0;">No projects added yet.</div>';
    return;
  }
  container.innerHTML = state._settingsProjects.map(name => {
    const isActive = name === state._settingsActiveProject;
    return `<div class="project-item${isActive ? ' active' : ''}" onclick="setActiveProject('${esc(name)}')">
      <div class="project-item-radio"></div>
      <span class="project-item-name">${esc(name)}</span>
      <button class="project-item-del" onclick="event.stopPropagation();deleteProjectFromSettings('${esc(name)}')" title="Remove">&times;</button>
    </div>`;
  }).join('');
}
function addProjectFromSettings() {
  const input = document.getElementById('settingsProjectInput');
  const name = input.value.trim();
  if (!name || state._settingsProjects.includes(name)) return;
  state._settingsProjects.push(name);
  if (!state._settingsActiveProject) state._settingsActiveProject = name;
  input.value = '';
  renderSettingsProjects();
}
function deleteProjectFromSettings(name) {
  state._settingsProjects = state._settingsProjects.filter(p => p !== name);
  if (state._settingsActiveProject === name) {
    state._settingsActiveProject = state._settingsProjects[0] || '';
  }
  renderSettingsProjects();
}
function setActiveProject(name) {
  state._settingsActiveProject = name;
  renderSettingsProjects();
}
function renderSettingsRepos() {
  const repos = state.configData.Repos || {};
  const container = document.getElementById('settingsRepoList');
  container.innerHTML = Object.entries(repos).map(([name, path]) => `
    <div class="repo-item">
      <span class="repo-item-name">${esc(name)}</span>
      <span class="repo-item-path">${esc(path)}</span>
      <button class="repo-item-del" onclick="deleteRepoFromSettings('${esc(name)}')" title="Remove">&times;</button>
    </div>
  `).join('');
  renderCloneSourceButtons('settingsRepoAddBtns', 'settings', 'modal-btn');
}
function addRepoFromSettings() {
  const name = document.getElementById('settingsRepoName').value.trim();
  const path = document.getElementById('settingsRepoPath').value.trim();
  if (!name || !path) return;
  state.configData.Repos = state.configData.Repos || {};
  state.configData.Repos[name] = path;
  document.getElementById('settingsRepoName').value = '';
  document.getElementById('settingsRepoPath').value = '';
  renderSettingsRepos();
}
function deleteRepoFromSettings(name) {
  if (state.configData.Repos) delete state.configData.Repos[name];
  renderSettingsRepos();
}

// ── Shared Repo Add flows (used by Settings & Onboarding) ──────────────────
function _repoAddCommit(ctx, name, repoPath) {
  if (ctx === 'settings') {
    state.configData.Repos = state.configData.Repos || {};
    state.configData.Repos[name] = repoPath;
    renderSettingsRepos();
  } else {
    state._obData.repos[name] = repoPath;
    obRenderRepos();
  }
}
function _repoPanel(ctx) {
  return document.getElementById(ctx === 'settings' ? 'settingsRepoAddPanel' : 'obRepoAddPanel');
}
function _repoHidePanel(ctx) {
  const panel = _repoPanel(ctx);
  if (panel) {
    panel.style.display = 'none';
    panel.innerHTML = '';
  }
}

// ── Browse Local Folder ─────────────────────────────────────────────────────
async function repoAddBrowse(ctx) {
  try {
    const res = await fetch('/api/browse-folder', {
      method: 'POST'
    });
    const data = await res.json();
    if (data.canceled) return;
    _repoAddCommit(ctx, data.name, data.path);
    toast('Repository added: ' + data.name, 'success');
  } catch (e) {
    toast('Failed to open folder picker', 'error');
  }
}

// ── Import repos via repoSources contributions (generic across plugins) ─────
const _repoSrcCache = new Map(); // sourceId -> { list, ts }

function _repoSources() {
  const d = window.Symphonee?.contributions?.data;
  return d && Array.isArray(d.repoSources) ? d.repoSources : [];
}
function _repoSourceById(id) {
  return _repoSources().find(s => s.id === id) || null;
}
function _resolveRoute(source, field) {
  return window.Symphonee?.contributions?.resolve?.(source, field) || null;
}
async function _fetchPluginRepos(source, query) {
  if (!source) throw new Error('No repo source');
  const now = Date.now();
  const cached = _repoSrcCache.get(source.id);
  if (!query && cached && now - cached.ts < 60000) return cached.list;
  const base = _resolveRoute(source, 'listRoute');
  if (!base) throw new Error('Repo source ' + source.id + ' has no listRoute');
  const sep = base.includes('?') ? '&' : '?';
  const qs = query ? `${sep}q=${encodeURIComponent(query)}&per_page=50` : `${sep}per_page=50`;
  const res = await fetch(base + qs);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const repos = data.repos || data.items || data;
  if (!query) _repoSrcCache.set(source.id, {
    list: repos,
    ts: now
  });
  return repos;
}
function _renderPluginRepoList(source, repos, ctx, mode) {
  if (!repos.length) return '<div style="font-size:11px;color:var(--subtext0);padding:8px 0;">No repos found.</div>';
  window._pluginRepoPicks = window._pluginRepoPicks || {};
  window._pluginRepoPicks[source.id] = repos;
  return repos.map((r, i) => {
    const name = r.full_name || r.name || r.path || '';
    const desc = r.description || '';
    const lang = r.language || '';
    const isPrivate = r.private || r.visibility === 'private';
    return `
      <div class="repo-src-pick" onclick="_pluginRepoSelected('${source.id}','${ctx}','${mode}',${i})" style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:var(--radius);transition:background 0.15s;" onmouseenter="this.style.background='var(--surface1)'" onmouseleave="this.style.background='none'">
        <i data-lucide="${isPrivate ? 'lock' : 'globe'}" style="width:12px;height:12px;color:var(--subtext0);flex-shrink:0;"></i>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</div>
          ${desc ? `<div style="font-size:10px;color:var(--subtext0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(desc)}</div>` : ''}
        </div>
        ${lang ? `<span style="font-size:9px;color:var(--subtext0);flex-shrink:0;">${esc(lang)}</span>` : ''}
      </div>`;
  }).join('');
}
async function _showPluginClonePicker(source, ctx, mode) {
  if (!source) {
    toast('No clone source available', 'error');
    return;
  }
  const panel = _repoPanel(ctx);
  panel.style.display = 'block';
  const label = source.label || 'Clone from ' + source.id;
  panel.innerHTML = `
    <div style="margin-top:8px;border:1px solid var(--surface1);border-radius:var(--radius);background:var(--surface0);overflow:hidden;">
      <div style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--surface1);">
        <i data-lucide="search" style="width:12px;height:12px;color:var(--subtext0);"></i>
        <input id="pluginRepoSearch_${ctx}" data-source="${esc(source.id)}" type="text" placeholder="Search ${esc(label)}..." oninput="_pluginRepoSearch('${source.id}','${ctx}','${mode}')" style="flex:1;background:none;border:none;color:var(--text);font-size:12px;outline:none;">
        <button onclick="_repoHidePanel('${ctx}')" style="background:none;border:none;color:var(--subtext0);cursor:pointer;font-size:14px;padding:0 2px;">&times;</button>
      </div>
      <div id="pluginRepoResults_${ctx}" style="max-height:200px;overflow-y:auto;padding:4px;">
        <div style="font-size:11px;color:var(--subtext0);padding:8px;">Loading...</div>
      </div>
    </div>`;
  try {
    lucide.createIcons();
  } catch (_) {}
  try {
    const repos = await _fetchPluginRepos(source);
    const results = document.getElementById(`pluginRepoResults_${ctx}`);
    if (results) {
      results.innerHTML = _renderPluginRepoList(source, repos, ctx, mode);
      try {
        lucide.createIcons();
      } catch (_) {}
    }
  } catch (e) {
    const results = document.getElementById(`pluginRepoResults_${ctx}`);
    if (results) results.innerHTML = `<div style="font-size:11px;color:var(--red);padding:8px;">${esc(e.message)}</div>`;
  }
}
state._pluginRepoSearchTimer = null;
function _pluginRepoSearch(sourceId, ctx, mode) {
  clearTimeout(state._pluginRepoSearchTimer);
  state._pluginRepoSearchTimer = setTimeout(async () => {
    const input = document.getElementById(`pluginRepoSearch_${ctx}`);
    const query = input ? input.value.trim() : '';
    const results = document.getElementById(`pluginRepoResults_${ctx}`);
    if (!results) return;
    const source = _repoSourceById(sourceId);
    results.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:8px;">Searching...</div>';
    try {
      const repos = await _fetchPluginRepos(source, query);
      results.innerHTML = _renderPluginRepoList(source, repos, ctx, mode);
      try {
        lucide.createIcons();
      } catch (_) {}
    } catch (e) {
      results.innerHTML = `<div style="font-size:11px;color:var(--red);padding:8px;">${esc(e.message)}</div>`;
    }
  }, 300);
}
async function _pluginRepoSelected(sourceId, ctx, mode, idx) {
  const source = _repoSourceById(sourceId);
  const repo = window._pluginRepoPicks && window._pluginRepoPicks[sourceId] && window._pluginRepoPicks[sourceId][idx];
  if (!source || !repo) return;
  _repoHidePanel(ctx);
  try {
    const res = await fetch('/api/browse-folder', {
      method: 'POST'
    });
    const data = await res.json();
    if (data.canceled) return;
    const displayName = repo.full_name || repo.name || '';
    toast('Cloning ' + displayName + '...', 'info');
    const cloneUrl = repo.clone_url || repo.cloneUrl || repo.http_url_to_repo || repo.ssh_url || '';
    const cloneRouteUrl = _resolveRoute(source, 'cloneRoute');
    if (!cloneRouteUrl) {
      toast('Clone route missing for ' + sourceId, 'error');
      return;
    }
    const cloneRes = await fetch(cloneRouteUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cloneUrl,
        destPath: data.path
      })
    });
    const cloneData = await cloneRes.json();
    if (cloneData.error) {
      toast('Clone failed: ' + cloneData.error, 'error');
      return;
    }
    _repoAddCommit(ctx, cloneData.name, cloneData.path);
    toast('Cloned and added: ' + cloneData.name, 'success');
  } catch (e) {
    toast('Clone failed: ' + e.message, 'error');
  }
}
function repoAddPluginClone(sourceId, ctx) {
  const source = _repoSourceById(sourceId);
  _showPluginClonePicker(source, ctx, 'clone');
}

// Render a "Clone from X" button for each contributed repoSource into a container.
function renderCloneSourceButtons(containerId, ctx, btnClass) {
  const host = document.getElementById(containerId);
  if (!host) return;
  // Remove previously injected plugin buttons (keep the Browse Local button).
  host.querySelectorAll('[data-plugin-clone-btn]').forEach(b => b.remove());
  const sources = _repoSources();
  for (const src of sources) {
    const btn = document.createElement('button');
    btn.className = btnClass || 'modal-btn';
    btn.setAttribute('data-plugin-clone-btn', src.id);
    btn.style.cssText = 'padding:6px 12px;font-size:11px;flex:1;display:flex;align-items:center;justify-content:center;gap:4px;';
    btn.onclick = () => repoAddPluginClone(src.id, ctx);
    btn.innerHTML = `<i data-lucide="${esc(src.icon || 'git-branch')}" style="width:13px;height:13px;"></i> ${esc(src.label || 'Clone from ' + src.id)}`;
    host.appendChild(btn);
  }
  try {
    lucide.createIcons();
  } catch (_) {}
}

// Legacy aliases so older HTML/call-sites keep working until they're swept.
function repoAddGitHubClone(ctx) {
  repoAddPluginClone('github', ctx);
}
async function _fetchGitHubRepos(query) {
  return _fetchPluginRepos(_repoSourceById('github'), query);
}
function _renderGitHubRepoList(repos, ctx, mode) {
  return _renderPluginRepoList(_repoSourceById('github'), repos, ctx, mode);
}
async function _showGitHubPicker(ctx, mode) {
  return _showPluginClonePicker(_repoSourceById('github'), ctx, mode);
}

// Track which settings require an app restart when changed.
// No setting currently requires a restart, so this is a no-op kept
// callable in case future settings need it.
function checkSettingsNeedRestart() {
  const btn = document.getElementById('settingsSaveBtn');
  if (!btn) return;
  btn.textContent = 'Save';
  btn._needsRestart = false;
}

// ── Smart Search (semantic embeddings) UI ─────────────────────────────
async function refreshSmartSearchStatus() {
  const statusEl = document.getElementById('smartSearchStatus');
  const btn = document.getElementById('smartSearchSetupBtn');
  const dl = document.getElementById('smartSearchDownloadLink');
  if (!statusEl || !btn || !dl) return;
  statusEl.textContent = 'Checking status...';
  btn.style.display = 'none';
  dl.style.display = 'none';
  try {
    const r = await fetch('/api/mind/embed-status').then(r => r.json());
    const v = r.vectors || {};
    const ol = r.ollama || {};
    if (r.activeProvider === 'ollama') {
      var chat = r.chat || {};
      var chatLine = chat.preferredModel ? ' Reflection model: ' + chat.preferredModel + '.' : ' Reflection model: downloading in background...';
      statusEl.textContent = 'Active: Local AI (Ollama / ' + (ol.model || '') + ') -- ' + (v.count || 0) + ' vectors. Runs entirely on your machine. New nodes embed automatically.' + chatLine;
      // Everything works -- expose the manual re-run as a quiet escape hatch.
      btn.style.display = 'inline-block';
    } else if (ol.installed && ol.running && !ol.modelInstalled) {
      statusEl.textContent = 'Mind is downloading the embedding model in the background. This page will update when it finishes.';
    } else if (ol.installed && !ol.running) {
      statusEl.textContent = 'Mind is launching Ollama in the background...';
    } else if (!ol.installed) {
      statusEl.textContent = 'Active: keyword search. Ollama is the only thing Symphonee cannot install for you -- one download and the rest happens automatically.';
      dl.href = r.downloadUrl || 'https://ollama.com/download';
      dl.style.display = 'inline-block';
    } else {
      statusEl.textContent = 'Active: keyword search. Smart Search is initializing in the background...';
      btn.style.display = 'inline-block';
    }
  } catch (e) {
    statusEl.textContent = 'Could not reach the Mind status endpoint.';
  }
}
async function startSmartSearchSetup() {
  const btn = document.getElementById('smartSearchSetupBtn');
  const progress = document.getElementById('smartSearchProgress');
  if (!btn || !progress) return;
  btn.disabled = true;
  btn.textContent = 'Setting up...';
  progress.style.display = 'block';
  progress.textContent = 'Starting...';
  try {
    await fetch('/api/mind/embed-setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
  } catch (e) {
    progress.textContent = 'Setup request failed: ' + e.message;
    btn.disabled = false;
    btn.textContent = 'Set up local smart search';
  }
  // Progress arrives via WebSocket mind-update events handled below.
}
function handleEmbedSetupEvent(payload) {
  const progress = document.getElementById('smartSearchProgress');
  const btn = document.getElementById('smartSearchSetupBtn');
  if (!progress) return;
  progress.style.display = 'block';
  const s = payload.step;
  const auto = payload.source === 'auto';
  if (s === 'detect') progress.textContent = (auto ? '[auto] ' : '') + 'Looking for Ollama...';else if (s === 'needs-install') {
    progress.textContent = 'Ollama is the only thing Symphonee cannot install for you. Use the download link above. Once installed, Mind picks it up automatically -- no clicks required.';
    refreshSmartSearchStatus();
  } else if (s === 'launching') progress.textContent = (auto ? '[auto] ' : '') + 'Launching Ollama...';else if (s === 'launch-failed') progress.textContent = 'Could not launch Ollama: ' + (payload.hint || payload.reason || 'unknown');else if (s === 'pulling-model') progress.textContent = (auto ? '[auto] ' : '') + 'Downloading embedding model (' + (payload.model || '') + ')...';else if (s === 'pulling-chat-model') progress.textContent = (auto ? '[auto] ' : '') + 'Downloading reflection model (' + (payload.model || '') + ')...';else if (s === 'chat-model-ready') {
    progress.textContent = 'Reflection model ready (' + (payload.model || '') + ').';
    refreshSmartSearchStatus();
  } else if (s === 'pull-failed') progress.textContent = 'Model download failed: ' + (payload.error || 'unknown');else if (s === 'dropping-old-vectors') progress.textContent = (auto ? '[auto] ' : '') + 'Clearing old vectors...';else if (s === 'rebuilding-vectors') progress.textContent = (auto ? '[auto] ' : '') + 'Building semantic search index...';else if (s === 'embed-progress') progress.textContent = (auto ? '[auto] ' : '') + (payload.msg || 'Embedding...');else if (s === 'embed-failed') progress.textContent = 'Embedding failed: ' + (payload.error || 'unknown');else if (s === 'done') {
    progress.textContent = 'Done. Local smart search is active.';
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Re-run setup manually';
    }
    refreshSmartSearchStatus();
  } else if (s === 'error') progress.textContent = 'Error: ' + (payload.error || 'unknown');
}
function handleOllamaPullEvent(payload) {
  const progress = document.getElementById('smartSearchProgress');
  if (!progress) return;
  if (payload.total && payload.completed) {
    const mb = n => (n / 1048576).toFixed(1);
    progress.textContent = 'Downloading ' + (payload.model || 'model') + ': ' + mb(payload.completed) + ' MB / ' + mb(payload.total) + ' MB';
  } else if (payload.status) {
    progress.textContent = 'Ollama: ' + payload.status;
  }
}

// Wire up the button + global WebSocket listener for embed-setup events.
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('smartSearchSetupBtn');
  if (btn) btn.addEventListener('click', startSmartSearchSetup);
});
// The main WebSocket is already established earlier in this file; we
// piggyback on the same connection by listening to message events on
// window.ws if it's exposed, otherwise add a passive listener for the
// custom event that the main handler dispatches. To keep things simple
// we hook the message globally — the main handler ignores unknown types
// so re-dispatching here is safe.
window.addEventListener('symphonee-mind-update', ev => {
  const payload = ev.detail || {};
  if (payload.kind === 'embed-setup') handleEmbedSetupEvent(payload);else if (payload.kind === 'ollama-pull') handleOllamaPullEvent(payload);
});
function openFactoryResetModal() {
  const el = document.getElementById('factoryResetModal');
  if (!el) return;
  el.classList.add('open');
  try {
    lucide.createIcons();
  } catch (_) {}
}
function closeFactoryResetModal() {
  const el = document.getElementById('factoryResetModal');
  if (el) el.classList.remove('open');
}
function factoryResetExportFirst() {
  const a = document.createElement('a');
  a.href = '/api/config/export';
  a.download = 'symphonee-settings.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Exported. Reopen the reset dialog when ready.', 'info');
  closeFactoryResetModal();
}
async function factoryResetConfirm() {
  closeFactoryResetModal();
  showLoading('Resetting...');
  try {
    const r = await fetch('/api/config/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        confirm: true
      })
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      hideLoading();
      toast(d.error || 'Reset failed', 'error');
      return;
    }
    // Wipe every client-side preference (custom themes, active theme, open
    // tabs, expanded parents, etc.) so the app relaunches truly from scratch
    // with the industrial-blue default rather than a stale localStorage entry.
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('symphonee-')) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch (_) {}
    toast('Reset complete. Restarting...', 'success');
    setTimeout(() => restartApp(), 600);
  } catch (e) {
    hideLoading();
    toast('Reset failed: ' + e.message, 'error');
  }
}
async function saveSettings() {
  // Safe readers - plugin-contributed settings fields can disappear from the
  // DOM when their owning plugin is uninstalled, and we still want the save +
  // restart flow to complete in that case (the uninstall already ran
  // server-side; we just need the relaunch).
  const _txt = id => {
    const el = document.getElementById(id);
    return el ? (el.value || '').trim() : '';
  };
  const _chk = id => {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  };
  try {
    const defaultCli = _txt('settingsDefaultCli') || state.activeCli || 'claude';
    const payload = {
      AzureDevOpsOrg: _txt('settingsOrg'),
      AzureDevOpsProject: state._settingsActiveProject,
      AzureDevOpsProjects: state._settingsProjects,
      AzureDevOpsPAT: _txt('settingsPAT'),
      DefaultTeam: _txt('settingsTeam'),
      DefaultUser: _txt('settingsUser'),
      GitHubPAT: _txt('settingsGitHubPAT'),
      OrchestrateCliList: Array.from(document.querySelectorAll('.orch-cli-cb:checked')).map(function (cb) {
        return cb.value;
      }),
      EnableContinuousLearning: _chk('settingsEnableContinuousLearning'),
      AiApiKeys: {
        OPENAI_API_KEY: _txt('settingsOpenaiKey') || undefined,
        GEMINI_API_KEY: _txt('settingsGeminiKey') || undefined,
        ANTHROPIC_API_KEY: _txt('settingsAnthropicKey') || undefined,
        XAI_API_KEY: _txt('settingsXaiKey') || undefined
      },
      OrchestrateResultDelivery: 'inject',
      BrowserCredentials: state.configData.BrowserCredentials || {},
      BrowserRouter: {
        default: _txt('settingsBrowserRouterDefault') || 'auto',
        preferStagehand: _chk('settingsBrowserRouterPreferStagehand')
      },
      InAppAgent: {
        model: _txt('settingsInAppAgentModel') || undefined
      },
      DefaultCli: defaultCli,
      Repos: state.configData.Repos || {}
    };
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    // Also save plugin settings + the Browser tab's plugin-scoped fields.
    await savePluginSettings();
    await saveBrowserSettings();
    if (data.ok) {
      const needsRestart = document.getElementById('settingsSaveBtn')?._needsRestart;
      if (needsRestart) {
        closeSettings();
        toast('Settings saved. Restarting...', 'success');
        setTimeout(() => restartApp(), 500);
        return;
      }
      // Did saving this config flip the activation state of any plugin?
      // Plugins whose activationConditions.configKeys just became satisfied
      // (or no longer are) need to be applied or removed. Most contributions
      // (centerTabs, rightTabs, leftQuickActions, etc.) are injected once
      // in the initPlugins IIFE and don't reconcile live, so the simplest
      // correct path is to restart when activation changes.
      const delta = await refreshPluginActivation();
      if (delta.added && delta.added.length || delta.removed && delta.removed.length) {
        closeSettings();
        toast('Plugin activation changed. Restarting to apply...', 'success');
        setTimeout(() => restartApp(), 500);
        return;
      }
      closeSettings();
      showLoading('Loading...');
      const minWait = new Promise(r => setTimeout(r, 4000));
      if (defaultCli && defaultCli !== state.activeCli) {
        switchCli(defaultCli);
      }
      const _sprintSel = document.getElementById('sprintSelect');
      if (_sprintSel) _sprintSel.innerHTML = '<option value="">All Iterations</option>';
      await loadConfig(true);
      loadVelocity();
      await minWait;
      hideLoading();
      toast('Settings saved', 'success');
    }
  } catch (e) {
    hideLoading();
    toast('Failed to save settings', 'error');
  }
}

// ── Export / Import Settings ────────────────────────────────────────────
function openExportImportMenu(btn) {
  // Close existing menu if any
  const existing = document.querySelector('.export-import-menu');
  if (existing) {
    existing.remove();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'export-import-menu';
  menu.innerHTML = `
    <button class="export-import-menu-item" onclick="exportSettings()">
      <i data-lucide="download" style="width:14px;height:14px;"></i> Export Settings
    </button>
    <button class="export-import-menu-item" onclick="importSettings()">
      <i data-lucide="upload" style="width:14px;height:14px;"></i> Import Settings
    </button>`;
  btn.style.position = 'relative';
  btn.appendChild(menu);
  try {
    lucide.createIcons();
  } catch (_) {}
  // Close on outside click
  setTimeout(() => {
    const close = e => {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}
function exportSettings() {
  document.querySelector('.export-import-menu')?.remove();
  const a = document.createElement('a');
  a.href = '/api/config/export';
  a.download = 'symphonee-settings.json';
  a.click();
  toast('Settings exported (PATs excluded for security)', 'success');
}
function importSettings() {
  document.querySelector('.export-import-menu')?.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await fetch('/api/config/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });
      const result = await res.json();
      if (result.ok) {
        closeSettings();
        showLoading(result.pluginsInstalled ? 'Importing settings and installing plugins...' : 'Importing settings...');
        const minWait = new Promise(r => setTimeout(r, 3000));
        await loadConfig(true);
        loadVelocity();
        await minWait;
        hideLoading();
        var msg = 'Settings imported successfully!';
        if (result.pluginsInstalled && result.pluginsInstalled.length > 0) {
          msg += ' Installed ' + result.pluginsInstalled.length + ' plugin(s): ' + result.pluginsInstalled.join(', ') + '.';
          msg += ' Restart the app to activate them.';
        }
        toast(msg, 'success');
      } else {
        toast(`Import failed: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      toast('Invalid settings file', 'error');
    }
  };
  input.click();
}