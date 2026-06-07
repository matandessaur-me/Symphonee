// ── Collapsible side panels ───────────────────────────────────────────────
function toggleLeftSidebar() {
  const collapsed = document.body.classList.toggle('left-collapsed');
  try {
    localStorage.setItem('sy-left-collapsed', collapsed ? '1' : '0');
  } catch (_) {}
  try {
    window.dispatchEvent(new Event('resize'));
  } catch (_) {}
}
function toggleRightSidebar() {
  const collapsed = document.body.classList.toggle('right-collapsed');
  try {
    localStorage.setItem('sy-right-collapsed', collapsed ? '1' : '0');
  } catch (_) {}
  try {
    window.dispatchEvent(new Event('resize'));
  } catch (_) {}
}
function restartShell() {
  const termId = state.activeTermId;
  const st = getTermAi(termId);
  st.launched = false;
  st.cli = null;
  document.getElementById('termStatus').textContent = 'Restarting...';
  document.getElementById('aiBtn').textContent = 'Launch AI';
  // Restore tab label
  const shellLabel = getShellLabel(termId);
  const tabEl = termId === 'main' ? document.getElementById('mainTermTab') : document.querySelector(`.term-tab[data-term="${termId}"] span`);
  if (tabEl) tabEl.textContent = shellLabel;
  document.getElementById('resumeBtn').style.display = 'none';
  state._shellReadyResolve = () => {};
  const inst = termInstances.get(termId);
  if (inst) inst.term.options.theme = getActiveTermTheme();
  const msg = JSON.stringify({
    type: 'restart',
    termId,
    cols: inst?.term.cols || 80,
    rows: inst?.term.rows || 24
  });
  if (state.ws && state.ws.readyState === 1) state.ws.send(msg);
  setTimeout(() => {
    if (state.ws && state.ws.readyState === 1) state.ws.send(msg);
  }, 500);
  if (inst) inst.term.clear();
}
function askAi(prompt) {
  switchTab('terminal');
  const running = isAiRunning(state.activeTermId);
  if (!running) launchAi();
  setTimeout(() => sendCommand(prompt, state.activeTermId), running ? 100 : 2000);
}

// ── Tab Switching ───────────────────────────────────────────────────────
function switchTab(tab, preserveSearch) {
  // Remap legacy direct calls to the now-nested sub-tabs: keep the top
  // "Automation" button highlighted and show the sub-tab strip while
  // activating the underlying panel.
  if (tab === 'browser' || tab === 'apps') {
    _setAutomationSubTab(tab, {
      activate: true
    });
    tab = 'automation';
  }
  // When we enter the synthetic automation tab, show the sub-bar and
  // resolve which child panel should be active.
  var panelTab = tab;
  if (tab === 'automation') {
    var sub = _getAutomationSubTab();
    _setAutomationSubTab(sub, {
      activate: false
    });
    panelTab = sub;
  } else {
    _hideAutomationSubBar();
  }
  try {
    // Record the underlying sub-tab too so consumers of activeTab can
    // still distinguish Apps vs Browser.
    const focus = {
      activeTab: tab
    };
    if (tab === 'automation') focus.activeAutomationSubTab = panelTab;
    _pushFocus(focus);
  } catch (_) {}
  document.querySelectorAll('.tab-btn').forEach(el => {
    var isActive = el.dataset.tab === tab;
    el.classList.toggle('active', isActive);
    // Plugin tint: color active tab text + border, clear inactive
    if (el.dataset.tint) {
      if (isActive) {
        el.style.color = 'rgb(' + el.dataset.tint + ')';
        el.style.borderBottomColor = 'rgb(' + el.dataset.tint + ')';
      } else {
        el.style.color = '';
        el.style.borderBottomColor = '';
      }
    }
  });
  // Notify Mind when it's leaving so it can freeze physics. Without this the
  // vis-network animation keeps drawing onto its (now-hidden) canvas and the
  // app stays laggy after you've moved on to Terminal/Orchestrator/etc.
  try {
    if (tab !== 'mind' && window.__lastTab === 'mind' && window.MindUI && window.MindUI.onDeactivate) {
      window.MindUI.onDeactivate();
    }
  } catch (_) {}
  window.__lastTab = tab;
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.toggle('active', el.id === `panel-${panelTab}`));
  // Scroll active tab into view if overflowed
  var activeBtn = document.querySelector('.tab-btn[data-tab="' + tab + '"]');
  if (activeBtn) activeBtn.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
    inline: 'nearest'
  });
  if (tab === 'terminal') {
    requestAnimationFrame(fitTerminalNow);
    const t = getActiveTerm();
    if (t) t.focus();
    loadTerminalScripts();
  }
  if (tab === 'backlog') {
    if (!preserveSearch) {
      const s = document.getElementById('backlogSearch');
      if (s) s.value = '';
    }
    applyBacklogFilters();
  }
  if (tab === 'files') {
    populateFilesRepoSelect();
    if (state.filesCurrentRepo) {
      loadFileTree(state.filesCurrentPath);
      loadProjectScripts();
    }
  }
  if (tab === 'prs') {
    populatePRsRepoSelect();
    loadPRs();
  }
  if (tab === 'notes') loadNotesList();
  if (tab === 'mind') {
    try {
      window.MindUI && window.MindUI.onActivate();
    } catch (_) {}
  }
  if (tab === 'orchestrator') orchRefresh();
  if (tab === 'ledger' && typeof ledgerLoad === 'function') ledgerLoad();
  if (panelTab === 'apps' && typeof appsRefreshWindows === 'function') appsRefreshWindows();
  notifyPluginIframes('tabActivated', {
    tab: panelTab
  });
}
const _AUTOMATION_SUB_KEY = 'symphonee-automation-subtab-v1';
function _getAutomationSubTab() {
  try {
    const v = localStorage.getItem(_AUTOMATION_SUB_KEY);
    if (v === 'browser' || v === 'apps') return v;
  } catch (_) {}
  return 'apps';
}
function _saveAutomationSubTab(v) {
  try {
    localStorage.setItem(_AUTOMATION_SUB_KEY, v);
  } catch (_) {}
}
function _hideAutomationSubBar() {
  const el = document.getElementById('automationSubtabs');
  if (el) el.style.display = 'none';
}
function _setAutomationSubTab(which, opts) {
  opts = opts || {};
  if (which !== 'browser' && which !== 'apps') which = 'apps';
  _saveAutomationSubTab(which);
  const bar = document.getElementById('automationSubtabs');
  const btnBrowser = document.getElementById('automationSubBrowser');
  const btnApps = document.getElementById('automationSubApps');
  if (bar) bar.style.display = 'flex';
  const activeStyle = 'background:var(--surface1);color:var(--text);';
  const inactiveStyle = 'background:transparent;color:var(--subtext1);';
  if (btnBrowser) btnBrowser.style.cssText += ';' + (which === 'browser' ? activeStyle : inactiveStyle);
  if (btnApps) btnApps.style.cssText += ';' + (which === 'apps' ? activeStyle : inactiveStyle);
}
function switchAutomationSubTab(which) {
  _setAutomationSubTab(which, {
    activate: true
  });
  switchTab('automation');
}
function switchIntelTab(tab) {
  document.querySelectorAll('.intel-tab').forEach(el => {
    var isActive = el.dataset.itab === tab;
    el.classList.toggle('active', isActive);
    if (el.dataset.tint) {
      if (isActive) {
        el.style.color = 'rgb(' + el.dataset.tint + ')';
        el.style.borderBottomColor = 'rgb(' + el.dataset.tint + ')';
      } else {
        el.style.color = '';
        el.style.borderBottomColor = '';
      }
    }
  });
  document.querySelectorAll('.intel-panel').forEach(el => el.classList.toggle('active', el.id === `ipanel-${tab}`));
  if (tab === 'velocity') loadVelocity();
  if (tab === 'team') loadTeamMembers();
  if (tab === 'gitlog') loadGitLogPanel();
  // Persist the selected right-panel (intel) tab so it's restored next launch.
  try {
    localStorage.setItem('symphonee-intel-tab', tab);
  } catch (_) {}
}

// ── UI Actions from AI ──────────────────────────────────────────────────
function handleUiAction(msg) {
  if (msg.action === 'switch-tab') {
    if (msg.tab === 'board') {
      switchTab('backlog');
      setTimeout(() => switchBacklogView('board'), 100);
    } else switchTab(msg.tab);
  }
  if (msg.action === 'view-workitem' && msg.id) viewWorkItem(msg.id);
  if (msg.action === 'view-note' && msg.name) {
    switchTab('notes');
    setTimeout(() => {
      openNote(msg.name).then(() => setNoteMode('preview'));
    }, 200);
  }
  if (msg.action === 'refresh-workitems') {
    loadWorkItems(true);
    // Also refresh the currently open work item detail if any
    if (state.currentWiDetail) viewWorkItem(state.currentWiDetail.id);
  }
  if (msg.action === 'refresh-notes') loadNotesList();
  if (msg.action === 'view-activity') openActivityTimeline();
  if (msg.action === 'file-changed') {
    // Refresh git status and diff tab when files change
    const repo = msg.repo || state.activeRepo || state.filesCurrentRepo;
    if (repo) loadGitStatusForDiffTab(repo);
  }
  if (msg.action === 'view-file' && msg.repo && msg.path) {
    state.filesCurrentRepo = msg.repo;
    state.activeRepo = msg.repo;
    switchTab('files');
    setTimeout(() => viewFile(msg.path, msg.line || undefined, msg.highlight || undefined), 300);
  }
  if (msg.action === 'view-commit-diff' && msg.hash) {
    const diffRepo = msg.repo || state.activeRepo || state.filesCurrentRepo;
    if (diffRepo) {
      state.filesCurrentRepo = diffRepo;
      state.activeRepo = diffRepo;
    }
    viewCommitDiff(msg.hash);
  }
  if (msg.action === 'view-diff') {
    const diffRepo = msg.repo || state.activeRepo || state.filesCurrentRepo;
    if (diffRepo) {
      state.filesCurrentRepo = diffRepo;
      state.activeRepo = diffRepo;
      if (msg.path) {
        switchTab('files');
        setTimeout(() => {
          viewFile(msg.path).then(() => showSplitDiff(msg.path, msg.base || 'HEAD'));
        }, 300);
      } else {
        viewChangedFile('').catch(() => {});
      }
    }
  }
  // PR actions
  if (msg.action === 'view-pr') {
    switchTab('prs');
    if (msg.repo) {
      state.prsCurrentRepo = msg.repo;
      populatePRsRepoSelect();
    }
    if (msg.number) setTimeout(() => viewPR(msg.number), 300);else loadPRs();
  }
  // Backlog view switching (board vs list)
  if (msg.action === 'switch-backlog-view' && msg.view) {
    switchTab('backlog');
    setTimeout(() => switchBacklogView(msg.view), 100);
  }
  // Open a plugin tab and optionally send a message to its iframe
  if (msg.action === 'view-plugin' && msg.plugin) {
    ensurePluginTabOpen(msg.plugin);
    // Forward any extra data to the plugin iframe via postMessage
    // Send twice: once quickly (if iframe is already loaded) and once after a delay (if iframe is freshly created)
    if (msg.message) {
      var _sendToPlugin = function () {
        var iframes = document.querySelectorAll('iframe[data-plugin-id="' + msg.plugin + '"]');
        iframes.forEach(function (f) {
          f.contentWindow.postMessage(Object.assign({
            __symphonee: true
          }, msg.message), location.origin);
        });
      };
      setTimeout(_sendToPlugin, 300);
      setTimeout(_sendToPlugin, 1500);
    }
  }
}