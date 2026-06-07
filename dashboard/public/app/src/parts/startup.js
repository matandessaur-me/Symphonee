// ── Bottom Hints Visibility ─────────────────────────────────────────────
async function updateScreenHint() {
  const hint = document.getElementById('switchScreenHint');
  if (!hint) return;
  try {
    const res = await fetch('/api/screen-info');
    const data = await res.json();
    hint.classList.toggle('visible', data.count > 1);
  } catch (_) {
    hint.classList.remove('visible');
  }
}
async function switchScreen() {
  try {
    const res = await fetch('/api/switch-screen', {
      method: 'POST'
    });
    const data = await res.json();
    if (data.switched) toast(`Moved to display ${data.display}/${data.total}`, 'info');
  } catch (_) {}
}

// Ctrl+S (save note) is now the 'save-note' entry in HOTKEY_ACTIONS, dispatched
// by the central keyboard hub so it is viewable/rebindable in Settings > Hotkeys.

// ── Open external links in system browser ───────────────────────────────
function openExternal(url) {
  // POST to server which uses Electron shell.openExternal or start command
  fetch('/api/open-external', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url
    })
  });
}

// Intercept all link clicks to open externally
document.addEventListener('click', e => {
  const link = e.target.closest('a[href]');
  if (link && link.href && (link.href.startsWith('http://') || link.href.startsWith('https://')) && !link.href.includes('127.0.0.1:3800')) {
    e.preventDefault();
    openExternal(link.href);
  }
});

// Override window.open for external URLs
const _origOpen = window.open;
window.open = function (url, target) {
  if (url && (url.startsWith('http://') || url.startsWith('https://')) && !url.includes('127.0.0.1:3800')) {
    openExternal(url);
    return null;
  }
  return _origOpen.call(window, url, target);
};

// ── Init ────────────────────────────────────────────────────────────────
switchCli(state.activeCli);
try {
  lucide.createIcons();
} catch (_) {}
connect();
// Initial orchestrator refresh so tasks show immediately on page load
setTimeout(() => orchRefresh(), 1000);
(async () => {
  console.info('[startup] loadConfig start');
  await loadConfig();
  console.info('[startup] loadConfig done; configData has Org?', !!state.configData.AzureDevOpsOrg, 'PAT?', !!state.configData.AzureDevOpsPAT);
  if (!state.configData.DefaultUser) {
    startOnboarding();
  }
  // Wait for initPlugins to finish populating _loadedPlugins, then re-run
  // the plugin-driven surfaces: pinned tab placement, sidebar visibility,
  // and the first work-items load. 3s timeout guards against the readiness
  // promise never resolving (network error, unexpected error path).
  try {
    if (typeof _pluginsReady !== 'undefined') {
      await Promise.race([_pluginsReady, new Promise(function (r) {
        setTimeout(r, 3000);
      })]);
    }
  } catch (_) {}
  console.info('[startup] _pluginsReady resolved; _loadedPlugins now has', state._loadedPlugins.length, 'plugins:', state._loadedPlugins.map(function (p) {
    return p.id;
  }).join(','));
  try {
    const delta = await refreshPluginActivation();
    console.info('[startup] post-load refresh delta: added=', (delta.added || []).map(function (p) {
      return p.id;
    }), 'removed=', (delta.removed || []).map(function (p) {
      return p.id;
    }));
    // Even without a delta, reconcile native tab claims now that
    // _loadedPlugins is guaranteed populated (closes the cold-start race).
    try {
      reconcilePluginShellSurfaces({
        preferActivityDefault: true
      });
      console.info('[startup] reconcilePluginShellSurfaces done');
    } catch (e) {
      console.warn('[startup] reconcilePluginShellSurfaces failed', e);
    }
    // Apply contributions for any plugin that activated between initPlugins
    // snapshot and this point (e.g. plugin config became valid mid-startup).
    for (var _i = 0; _i < (delta.added || []).length; _i++) {
      var _p = delta.added[_i];
      var _c = _p.contributions || {};
      if (_c.sidebarActions) _c.sidebarActions.forEach(function (a) {
        injectSidebarAction(_p, a);
      });
      if (_c.leftQuickActions) _c.leftQuickActions.forEach(function (a) {
        var container = document.getElementById('sidebarPluginActions');
        if (!container) return;
        var btn = document.createElement('button');
        btn.className = 'btn';
        btn.innerHTML = '<i data-lucide="' + (a.icon || 'puzzle') + '"></i> ' + a.label;
        btn.onclick = function () {
          runPluginAiAction(_p, a);
        };
        container.appendChild(btn);
      });
      if (_c.aiActions) _c.aiActions.forEach(function (a) {
        injectAiAction(_p, a);
      });
      if (_c.centerTabs) _c.centerTabs.forEach(function (t) {
        registerPluginTab(_p, t);
      });
      if (_c.rightTabs) _c.rightTabs.forEach(function (ip) {
        injectIntelPanel(_p, ip);
      });
    }
    try {
      lucide.createIcons();
    } catch (_) {}
    // loadConfig() ran before _pluginsReady resolved, so its `if (hasAdo)` block
    // (which seeds repos / teams / iterations / work items) skipped. Re-run the
    // ADO init now that the plugin set is known. All these calls are idempotent.
    var adoActive = state._loadedPlugins.some(function (p) {
      return p.contributions && p.contributions.workItemProvider;
    });
    if (adoActive) {
      try {
        if (typeof loadTeams === 'function') loadTeams();
      } catch (_) {}
      try {
        if (typeof loadAreas === 'function') loadAreas();
      } catch (_) {}
      try {
        if (typeof loadRepoList === 'function') loadRepoList();
      } catch (_) {}
      try {
        if (typeof loadTeamMembers === 'function') loadTeamMembers();
      } catch (_) {}
      try {
        if (typeof loadIterations === 'function') await loadIterations(true);
      } catch (_) {}
      try {
        if (typeof loadWorkItems === 'function') await loadWorkItems(false);
      } catch (_) {}
    }
  } catch (_) {}
})();

// ── Per-Shell AI Controls ──────────────────────────────────────────────

// Close AI picker on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.ai-picker-wrap')) {
    document.getElementById('aiPickerMenu')?.classList.remove('open');
  }
});
function getTermAi(termId) {
  const tid = termId || state.activeTermId;
  if (!termAiState.has(tid)) termAiState.set(tid, {
    cli: null,
    launched: false,
    orchestrated: false,
    taskId: null
  });
  return termAiState.get(tid);
}
function isAiRunning(termId) {
  return getTermAi(termId).launched;
}

// Apply the current visual theme's terminal colors to all terminals
function applyShellTheme() {
  const th = getActiveTermTheme();
  for (const [tid, inst] of termInstances) {
    inst.term.options.theme = th;
  }
  const termPanel = document.getElementById('panel-terminal');
  if (termPanel) termPanel.style.background = th.background;
  // Monaco needs its base (vs vs-dark) re-picked when the shell theme changes.
  try {
    if (typeof _defineMonacoTheme === 'function' && state.monacoReady) _defineMonacoTheme();
  } catch (_) {}
}

// Restart every connected terminal's PTY so the new theme is applied cleanly.
// Called when the user picks or saves a theme; no-op before the WebSocket is up.
function restartAllTerminalsForTheme() {
  if (!state.ws || state.ws.readyState !== 1) return;
  const th = getActiveTermTheme();
  for (const [tid, inst] of termInstances) {
    if (!inst || !inst.term) continue;
    inst.term.options.theme = th;
    const msg = JSON.stringify({
      type: 'restart',
      termId: tid,
      cols: inst.term.cols || 80,
      rows: inst.term.rows || 24
    });
    try {
      state.ws.send(msg);
    } catch (_) {}
    try {
      inst.term.clear();
    } catch (_) {}
    const st = termAiState.get(tid);
    if (st) {
      st.launched = false;
      st.cli = null;
    }
  }
  try {
    document.getElementById('termStatus').textContent = 'Shell ready';
    document.getElementById('aiBtn').textContent = 'Launch AI';
  } catch (_) {}
}

// ── Running-AI detection ─────────────────────────────────────────────────
// The frontend maintains a termAiState Map that gets blown away on reload,
// so after a refresh the button would show "Launch AI" even while the CLI
// is actually running in the PTY. Server inspects the PTY process tree and
// returns the CLI name (claude / codex / ...) or null per terminal.
async function _pollRunningAis() {
  try {
    const ids = Array.from(termInstances.keys());
    if (!ids.length) return;
    const res = await fetch('/api/term/detect-ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        termIds: ids
      })
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const byTerm = data && data.byTerm || {};
    let changed = false;
    for (const tid of ids) {
      const detected = byTerm[tid] || null;
      const st = getTermAi(tid);
      if (detected && (!st.launched || st.cli !== detected)) {
        st.launched = true;
        st.cli = detected;
        changed = true;
      } else if (!detected && st.launched) {
        st.launched = false;
        st.cli = null;
        changed = true;
      }
    }
    if (changed) {
      try {
        syncAiControls();
      } catch (_) {}
    }
  } catch (_) {}
}
// First sweep shortly after load, then every 3s while the app is in use.
setTimeout(_pollRunningAis, 1500);
setInterval(_pollRunningAis, 3000);

// Update the shared AI button/status for the current active shell.
// When an AI is running, the button flips to "Restart Shell" (which fully
// tears down the PTY and relaunches) - a harder reset than "Stop AI", which
// was unreliable in practice.
function syncAiControls() {
  const st = getTermAi(state.activeTermId);
  const btn = document.getElementById('aiBtn');
  const status = document.getElementById('termStatus');
  if (st.launched) {
    const cfg = CLI_CONFIG[st.cli];
    btn.textContent = 'Restart Shell';
    status.textContent = `${cfg.label} running`;
  } else {
    btn.textContent = 'Launch AI';
    status.textContent = 'Shell ready';
  }
}
function switchCli(cli) {
  state.activeCli = cli;
  localStorage.setItem('symphonee-cli', cli);
  // Theme is independent of AI selection - no theme change here
}
function toggleAi() {
  const st = getTermAi(state.activeTermId);
  if (st.launched) {
    // "Restart Shell" path: full PTY reset, which also drops the AI process.
    try {
      restartShell();
    } catch (_) {}
  } else {
    // Show picker so user can choose which AI, filtered to installed CLIs only.
    const menu = document.getElementById('aiPickerMenu');
    if (!menu) return;
    refreshAiPickerItems(menu);
    menu.classList.toggle('open');
  }
}

// Hide picker entries for CLIs that aren't installed. Uses the cached
// _aiToolsStatus when available, falls back to a fresh /api/prerequisites fetch.
async function refreshAiPickerItems(menu) {
  const apply = status => {
    const items = menu.querySelectorAll('.ai-picker-item');
    let visible = 0;
    items.forEach(el => {
      const m = /launchAiWith\('([^']+)'\)/.exec(el.getAttribute('onclick') || '');
      if (!m) return;
      const installed = !!(status[m[1]] && status[m[1]].installed);
      el.style.display = installed ? '' : 'none';
      if (installed) visible++;
    });
    if (!visible) {
      let empty = menu.querySelector('.ai-picker-empty');
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'ai-picker-empty';
        empty.style.cssText = 'padding:8px 10px;font-size:11px;color:var(--subtext0);';
        empty.textContent = 'No AI CLIs installed. Open Settings > AI Tools to install one.';
        menu.appendChild(empty);
      }
    } else {
      menu.querySelector('.ai-picker-empty')?.remove();
    }
  };
  if (state._aiToolsStatus && Object.keys(state._aiToolsStatus).length) {
    apply(state._aiToolsStatus);
    return;
  }
  try {
    const res = await fetch('/api/prerequisites');
    const data = await res.json();
    state._aiToolsStatus = data.cliTools || {};
    apply(state._aiToolsStatus);
  } catch (_) {
    // On failure, leave all items visible - degrades gracefully.
  }
}
state._shellReadyResolve = null; // YOLO mode flags per CLI (auto-approve all permissions)
const YOLO_FLAGS = {
  claude: '--dangerously-skip-permissions',
  gemini: '--yolo',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  copilot: '--yolo',
  grok: '--permission-mode full',
  qwen: '--yolo'
};
function launchAiWith(cli) {
  try {
    markOnboarding('launch');
  } catch (_) {}
  document.getElementById('aiPickerMenu')?.classList.remove('open');
  const cfg = CLI_CONFIG[cli];
  const termId = state.activeTermId;
  function doLaunch() {
    let cmd = cfg.cmd;
    // Append YOLO flags when the permission mode implies auto-approval.
    // Mode === 'bypass' always; 'trusted' only when launching inside a worktree path.
    const mode = state.permModeCache && state.permModeCache.mode || 'edit';
    const termCwd = termInstances.get(termId) && termInstances.get(termId).cwd || '';
    const inWorktree = /worktree/i.test(termCwd);
    const shouldYolo = mode === 'bypass' || mode === 'trusted' && inWorktree;
    if (shouldYolo && YOLO_FLAGS[cli]) {
      cmd += ' ' + YOLO_FLAGS[cli];
    }
    // Pre-trust the working folder so the CLI's first-run "do you trust this
    // folder?" prompt doesn't block the launch. Non-fatal if it fails.
    try {
      fetch('/api/cli/pretrust', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cli,
          cwd: termCwd || ''
        })
      }).catch(() => {});
    } catch (_) {}
    // Clear the screen before the CLI takes over so there is no residue.
    sendCommand('cls; ' + cmd, termId);
    const st = getTermAi(termId);
    st.cli = cli;
    st.launched = true;
    try {
      if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
        type: 'term-ai-state',
        termId,
        cli,
        launched: true
      }));
    } catch (_) {}
    const inst = termInstances.get(termId);
    // Update tab label
    const tabEl = termId === 'main' ? document.getElementById('mainTermTab') : document.querySelector(`.term-tab[data-term="${termId}"] span`);
    if (tabEl) tabEl.textContent = cfg.label;
    document.getElementById('resumeBtn').style.display = 'none';
    syncAiControls();
    if (typeof orchRefreshAgents === 'function') orchRefreshAgents();
  }
  if (state._shellReadyResolve) {
    const prev = state._shellReadyResolve;
    state._shellReadyResolve = () => {
      prev();
      setTimeout(doLaunch, 500);
    };
  } else {
    doLaunch();
  }
}
async function launchAi() {
  // Don't dump a bare command into the shell (raw "'claude' is not recognized")
  // when the default CLI isn't installed. Check first, then guide.
  if (!state._aiToolsStatus || !Object.keys(state._aiToolsStatus).length) {
    try { const r = await fetch('/api/prerequisites'); const d = await r.json(); state._aiToolsStatus = d.cliTools || {}; } catch (_) {}
  }
  const status = state._aiToolsStatus || {};
  // Couldn't detect anything -> don't block; fall back to the old behavior.
  if (!Object.keys(status).length) { launchAiWith(state.activeCli); return; }
  const active = state.activeCli;
  if (active && status[active] && status[active].installed) { launchAiWith(active); return; }
  const installed = Object.keys(status).filter((k) => status[k] && status[k].installed);
  if (installed.length) {
    if (typeof toast === 'function') toast('"' + active + '" is not installed -- pick an installed AI.', 'info');
    if (typeof toggleAi === 'function') toggleAi();
    return;
  }
  if (typeof toast === 'function') toast('No AI CLIs installed yet. Opening Settings > AI Tools.', 'info');
  if (typeof openSettings === 'function') openSettings('ai');
}
function stopAi(termId) {
  const tid = termId || state.activeTermId;
  const st = getTermAi(tid);
  if (!st.launched) return;
  // Send Ctrl+C then exit to the AI process
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
    type: 'input',
    termId: tid,
    data: '\x03'
  }));
  setTimeout(() => {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
      type: 'input',
      termId: tid,
      data: 'exit\r'
    }));
  }, 500);
  setTimeout(() => {
    const inst = termInstances.get(tid);
    if (inst) inst.term.clear();
  }, 1000);
  st.launched = false;
  st.cli = null;
  try {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
      type: 'term-ai-state',
      termId: tid,
      cli: null,
      launched: false
    }));
  } catch (_) {}
  const inst = termInstances.get(tid);
  // Restore tab label
  const shellLabel = getShellLabel(tid);
  const tabEl = tid === 'main' ? document.getElementById('mainTermTab') : document.querySelector(`.term-tab[data-term="${tid}"] span`);
  if (tabEl) tabEl.textContent = shellLabel;
  if (tid === state.activeTermId) syncAiControls();
  checkResumeAvailable();
  if (typeof orchRefreshAgents === 'function') orchRefreshAgents();
}
function getShellLabel(termId) {
  if (termId === 'main') return 'Shell 1';
  const inst = termInstances.get(termId);
  if (inst && inst.label && !Object.values(CLI_CONFIG).some(c => c.label === inst.label)) return inst.label;
  // Fallback: compute from position
  let num = 2;
  for (const [id] of termInstances) {
    if (id === 'main') continue;
    if (id === termId) return `Shell ${num}`;
    num++;
  }
  return 'Shell';
}
async function checkResumeAvailable() {
  const btn = document.getElementById('resumeBtn');
  if (btn) btn.style.display = 'none';
}
function resumeAiSession() {
  const btn = document.getElementById('resumeBtn');
  const cmd = btn?.dataset.cmd;
  if (!cmd) return;
  sendCommand(cmd, state.activeTermId);
  const st = getTermAi(state.activeTermId);
  st.cli = state.activeCli;
  st.launched = true;
  try {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
      type: 'term-ai-state',
      termId: state.activeTermId,
      cli: state.activeCli,
      launched: true
    }));
  } catch (_) {}
  const cfg = CLI_CONFIG[state.activeCli];
  const tabEl = state.activeTermId === 'main' ? document.getElementById('mainTermTab') : document.querySelector(`.term-tab[data-term="${state.activeTermId}"] span`);
  if (tabEl) tabEl.textContent = cfg.label;
  btn.style.display = 'none';
  syncAiControls();
}
function sendCommand(cmd, termId) {
  const tid = termId || 'main';
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
    type: 'input',
    termId: tid,
    data: cmd + '\r'
  }));
}
async function restartApp() {
  try {
    await fetch('/api/restart-app', {
      method: 'POST'
    });
  } catch (_) {/* connection drops as app restarts */}
}

// ── App update ────────────────────────────────────────────────────────────
async function checkForUpdates() {
  try {
    const res = await fetch('/api/check-updates');
    const data = await res.json();
    const btn = document.getElementById('updateBtn');
    if (data.updateAvailable && btn) {
      btn.style.display = 'flex';
      btn.title = data.behind + ' new commit' + (data.behind > 1 ? 's' : '') + ' available';
    }
  } catch (_) {/* not in Electron or network error */}
}
async function applyUpdate() {
  const btn = document.getElementById('updateBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Updating...';
  btn.style.opacity = '0.7';
  btn.style.cursor = 'wait';
  toast('Updating Symphonee...', 'info');
  try {
    const res = await fetch('/api/update-app', {
      method: 'POST'
    });
    const data = await res.json();
    if (!data.ok) {
      toast('Update failed: ' + (data.error || 'unknown error'), 'error');
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Update available';
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      return;
    }
    toast('Update installed, restarting...', 'info');
  } catch (_) {/* connection drops as app restarts */}
}

// Check for updates on startup (delayed so it doesn't slow down load)
setTimeout(checkForUpdates, 5000);