// command-palette -- the Ctrl+K/J command palette + AI-focus palette + quick-ask,
// the shortcut-help view, and the repo-map modal (generate/view/copy/save/send).
// esbuild IIFE; the search/render/dispatch helpers (incl. renderMarkdownToHtml)
// stay private. Reads the shared `state` at top level, so it loads AFTER app.js.
// Consumes HOTKEY_ACTIONS (keyboard.js) + CLI_CONFIG (terminals), both exposed on
// window by their owners; esc/toast/notify/openNote/... resolve via window.
// See ARCHITECTURE.md.
//
// ── Command Palette ─────────────────────────────────────────────────────
state._cmdSelectedIdx = 0;
state._cmdFiltered = []; // ── Knowledge Specs (KIT): open the Mind tab Specs view ─────────────────────
function openMindSpecs() {
  try {
    closeCmdPalette();
  } catch (_) {}
  try {
    switchTab("mind");
  } catch (_) {}
  setTimeout(() => {
    try {
      if (window.MindUI) MindUI.setView("specs");
    } catch (_) {}
  }, 80);
}
function getCmdActions() {
  const repos = state.configData.Repos ? _repoNamesForSpace(state.configData.Repos, window._spacesCache || {}, state.activeSpace) : [];
  // Palette feature flags derive from provider contributions, not plugin ids,
  // so a Jira or GitLab plugin unlocks the same surfaces without core edits.
  const hasAdo = !!(state._loadedPlugins || []).some(p => p.contributions && p.contributions.workItemProvider);
  const hasGh = !!(state._loadedPlugins || []).some(p => p.contributions && p.contributions.prProvider);
  const actions = [
  // Navigation (core always-on)
  {
    label: 'Go to Terminal',
    icon: 'terminal',
    action: () => switchTab('terminal'),
    category: 'Navigate',
    hint: 'Ctrl+T'
  }, {
    label: 'Go to Files',
    icon: 'folder',
    action: () => switchTab('files'),
    category: 'Navigate',
    hint: 'Browse and open repo files'
  }, {
    label: 'Go to Notes',
    icon: 'file-text',
    action: () => switchTab('notes'),
    category: 'Navigate',
    hint: 'Your notes and learnings'
  },
  // Core actions (always-on)
  {
    label: 'Refresh',
    icon: 'refresh-cw',
    action: () => refreshAll(),
    category: 'Action',
    hint: 'Ctrl+R'
  }, {
    label: 'Generate Repo Map',
    icon: 'map',
    action: () => openRepoMapModal(),
    category: 'Action',
    hint: 'Symbol map of the active repo'
  }, {
    label: 'Analyze Repo',
    icon: 'brain',
    action: () => analyzeActiveRepo(),
    category: 'AI',
    hint: 'Generate a repo map and send it to the AI'
  }, {
    label: 'Search Notes + Learnings',
    icon: 'search',
    action: () => {
      document.getElementById('cmdPaletteInput').value = 'find ';
      filterCmdPalette();
    },
    category: 'Action',
    hint: 'find <query>'
  }, {
    label: 'Knowledge Specs (KIT)',
    icon: 'package',
    action: () => openMindSpecs(),
    category: 'Mind',
    hint: 'Search your knowledge, view a spec, export/import as a KIT'
  }, {
    label: 'Skills',
    icon: 'list-checks',
    action: () => openMindSkills(),
    category: 'Mind',
    hint: 'Procedures every CLI follows; browse, author, review proposed skills'
  },
  // Git (local ops always work; remote pull/push still listed but fail gracefully without auth)
  {
    label: 'Switch Branch',
    icon: 'git-branch',
    action: () => openGitModal('branches'),
    category: 'Git',
    hint: 'Check out a different branch'
  }, {
    label: 'Commit Changes',
    icon: 'git-commit',
    action: () => openGitModal('commit'),
    category: 'Git',
    hint: 'Stage and commit working changes'
  }, {
    label: 'Compare Branches',
    icon: 'git-compare',
    action: () => openGitModal('compare'),
    category: 'Git',
    hint: 'Diff two branches'
  },
  // AI (core)
  {
    label: 'Launch AI',
    icon: 'play',
    action: () => {
      if (!aiLaunched) launchAi();
      switchTab('terminal');
    },
    category: 'AI',
    hint: 'Start the AI in the terminal'
  }, {
    label: 'Stop AI',
    icon: 'square',
    action: () => {
      if (aiLaunched) stopAi();
    },
    category: 'AI',
    hint: 'Stop the running AI session'
  }, {
    label: 'Resume Session',
    icon: 'rotate-ccw',
    action: () => {
      resumeAiSession();
      switchTab('terminal');
    },
    category: 'AI',
    hint: 'Resume the last AI session'
  },
  // Settings
  {
    label: 'Open Settings',
    icon: 'settings',
    action: () => openSettings(),
    category: 'Settings',
    hint: 'Repos, plugins, and AI keys'
  }, {
    label: 'Run Setup (Onboarding)',
    icon: 'sparkles',
    action: () => startOnboarding(),
    category: 'Settings',
    hint: 'Re-run the welcome / setup wizard'
  },
  // Scheduled jobs (recurring prompts to any CLI)
  {
    label: 'Scheduled Jobs',
    icon: 'calendar-clock',
    action: () => openJobsModal(),
    category: 'AI',
    hint: 'Run AI prompts on a schedule'
  }, {
    label: 'Create Scheduled Job',
    icon: 'plus',
    action: () => openJobEditor(),
    category: 'AI',
    hint: 'Schedule a recurring AI prompt'
  }];
  // Plugin-contributed quick actions + AI actions. No plugin names hardcoded.
  // The palette reads from each loaded plugin's leftQuickActions and aiActions
  // contributions - same surface the sidebar uses. Third-party plugins that
  // ship their own quick actions appear here for free.
  if (state._loadedPlugins && state._loadedPlugins.length) {
    for (const p of state._loadedPlugins) {
      const c = p.contributions || {};
      const category = p.name || p.id;
      for (const a of c.leftQuickActions || []) {
        actions.push({
          label: a.label,
          icon: a.icon || 'puzzle',
          category,
          action: () => {
            try {
              runPluginAiAction(p, a);
            } catch (_) {}
          }
        });
      }
      for (const a of c.aiActions || []) {
        actions.push({
          label: a.label,
          icon: a.icon || 'sparkles',
          category: category + ' AI',
          action: () => {
            try {
              runPluginAiAction(p, a);
            } catch (_) {}
          },
          hint: a.prompt ? String(a.prompt).slice(0, 80) : ''
        });
      }
    }
  }
  // Plugin pinned tabs become "Go to <label>" command palette entries.
  // Popup tabs are intentionally excluded - they are opened by domain actions
  // (clicking a work item, "Open Full Timeline"), not from the palette.
  if (state._loadedPlugins && state._loadedPlugins.length) {
    for (const p of state._loadedPlugins) {
      const c = p.contributions || {};
      const pinned = (c.centerTabs || []).filter(t => t && t.pinned);
      for (const t of pinned) {
        let dataTab = null;
        let label = t.label || t.id;
        if (t.claims && t.claims.tabBtnId) {
          const btn = document.getElementById(t.claims.tabBtnId);
          if (btn) {
            dataTab = btn.dataset.tab || t.claims.tabBtnId;
            if (!t.label) label = (btn.textContent || t.claims.tabBtnId).trim();
          }
        } else if (t.html) {
          dataTab = 'plugin-' + p.id + '-' + t.id;
        }
        if (!dataTab) continue;
        actions.push({
          label: 'Go to ' + label,
          icon: t.icon || 'layout',
          category: 'Navigate',
          action: () => {
            try {
              switchTab(dataTab);
            } catch (_) {}
          }
        });
      }
    }
  }
  // Repos
  for (const name of repos) {
    actions.push({
      label: `Switch to ${name}`,
      icon: 'git-branch',
      action: () => selectRepo(name),
      category: 'Repo'
    });
  }
  // Recipes (project-local + user-global). Loaded synchronously from cache.
  // Work items (top 20 recent)
  const recentWi = [...state.workItems].sort((a, b) => new Date(b.changedDate) - new Date(a.changedDate)).slice(0, 20);
  for (const wi of recentWi) {
    actions.push({
      label: `#${wi.id} ${wi.title}`,
      icon: wi.type === 'Bug' ? 'bug' : wi.type === 'Task' ? 'check-square' : 'bookmark',
      action: () => viewWorkItem(wi.id),
      category: 'Work Item'
    });
  }
  // (Duplicate plugin contribution pass removed - leftQuickActions, aiActions,
  // and centerTabs are already added once above via _loadedPlugins. Looping a
  // second time produced duplicate entries and incorrectly routed claimed/popup
  // tabs through openPluginTab() instead of switchTab(claims.tabBtnId).)

  // Plugin-contributed cached items (loaded async)
  if (state._pluginCmdItems && state._pluginCmdItems.length) {
    for (const item of state._pluginCmdItems) actions.push(item);
  }
  return actions;
}

// Async-load plugin items for command palette (called after plugins init)
state._pluginCmdItems = [];
async function loadPluginCmdItems() {
  state._pluginCmdItems = [];
  if (!state._loadedPlugins) return;
  for (const p of state._loadedPlugins) {
    try {
      const cfg = await (await fetch('/api/plugins/' + p.id + '/config')).json();
      if (!cfg.configured) continue;
    } catch (_) {
      continue;
    }
    if (p.id === 'wrike') {
      try {
        const tasks = await (await fetch('/api/plugins/wrike/tasks?limit=20')).json();
        if (Array.isArray(tasks)) {
          for (const t of tasks) {
            state._pluginCmdItems.push({
              label: t.title,
              icon: 'check-square',
              action: () => {
                openPluginTab('plugin-wrike-board');
                var iframes = document.querySelectorAll('iframe[data-plugin-id="wrike"]');
                iframes.forEach(function (f) {
                  f.contentWindow.postMessage({
                    __symphonee: true,
                    type: 'viewTask',
                    taskId: t.id
                  }, location.origin);
                });
              },
              category: 'Wrike'
            });
          }
        }
      } catch (_) {}
    }
    if (p.id === 'builderio') {
      try {
        const models = await (await fetch('/api/plugins/builderio/models')).json();
        if (Array.isArray(models)) {
          for (const m of models) {
            const displayName = m.name.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            state._pluginCmdItems.push({
              label: displayName + ' (' + m.kind + ', ' + m.fieldCount + ' fields)',
              icon: 'blocks',
              action: () => {
                openPluginTab('plugin-builderio-manager');
                var iframes = document.querySelectorAll('iframe[data-plugin-id="builderio"]');
                iframes.forEach(function (f) {
                  f.contentWindow.postMessage({
                    __symphonee: true,
                    type: 'openModel',
                    modelId: m.id
                  }, location.origin);
                });
              },
              category: 'Builder.io'
            });
          }
        }
      } catch (_) {}
    }
  }
}
const PALETTE_SUGGESTIONS = ['Summarize the current note', 'What changed in the active repo today', 'Draft an email from my last note', 'Plan tomorrow from my recent notes'];
function openCmdPalette() {
  const el = document.getElementById('cmdPalette');
  el.classList.add('open');
  const input = document.getElementById('cmdPaletteInput');
  input.value = '';
  state._cmdSelectedIdx = 0;
  filterCmdPalette();
  renderPaletteSuggestions();
  setTimeout(() => input.focus(), 50);
  try {
    markOnboarding('palette');
  } catch (_) {}
}

// ── Starter suggestions shown above the command list when input is empty.
// Gives new users (and non-devs) an obvious on-ramp without reading docs.
function renderPaletteSuggestions() {
  const list = document.getElementById('cmdPaletteList');
  if (!list) return;
  const input = document.getElementById('cmdPaletteInput');
  if (input && input.value.trim()) return;

  // AI query history: 3 most-recently-asked prompts. Clicking re-sends.
  const aiHist = _readAiHistory().slice(0, 3);
  let histBlock = '';
  if (aiHist.length) {
    const items = aiHist.map((h, i) => '<div class="cmd-recent-item" data-hist-idx="' + i + '" title="' + (h.prompt || '').replace(/"/g, '&quot;') + '">' + '<i data-lucide="sparkles" style="width:12px;height:12px;"></i>' + '<span>' + esc((h.prompt || '').slice(0, 80)) + '</span>' + '<span class="cmd-recent-cat">Ask again</span>' + '<button class="cmd-recent-del" data-del-hist="' + i + '" title="Remove from history"><i data-lucide="x" style="width:11px;height:11px;"></i></button>' + '</div>').join('');
    histBlock = '<div class="cmd-suggest-block">' + '<div class="cmd-suggest-heading">Recent prompts</div>' + '<div class="cmd-recent-list">' + items + '</div>' + '</div>';
  }

  // Recents row: quick re-run of the last 5 palette picks.
  const recents = _getRecentPaletteActions();
  let recentsBlock = '';
  if (recents.length) {
    const items = recents.map((r, i) => '<div class="cmd-recent-item" data-recent-idx="' + i + '">' + '<i data-lucide="' + (r.icon || 'clock') + '" style="width:12px;height:12px;"></i>' + '<span>' + esc(r.label) + '</span>' + '<span class="cmd-recent-cat">' + esc(r.category || '') + '</span>' + '</div>').join('');
    recentsBlock = '<div class="cmd-suggest-block">' + '<div class="cmd-suggest-heading">Recent</div>' + '<div class="cmd-recent-list">' + items + '</div>' + '</div>';
  }
  const chips = PALETTE_SUGGESTIONS.map(s => '<button class="cmd-suggest-chip" data-prompt="' + s.replace(/"/g, '&quot;') + '">' + '<i data-lucide="sparkles" style="width:11px;height:11px;"></i>' + esc(s) + '</button>').join('');
  const suggestBlock = '<div class="cmd-suggest-block">' + '<div class="cmd-suggest-heading">Try asking</div>' + '<div class="cmd-suggest-chips">' + chips + '</div>' + '</div>';
  list.insertAdjacentHTML('afterbegin', histBlock + recentsBlock + suggestBlock);
  list.querySelectorAll('.cmd-suggest-chip').forEach(el => {
    el.addEventListener('click', () => {
      const p = el.dataset.prompt || '';
      askAIFromPalette(p);
    });
  });
  // Two kinds of recent rows coexist: recent palette actions (-recent-idx)
  // and recent AI prompts (-hist-idx). Differentiate by attribute.
  list.querySelectorAll('.cmd-recent-item').forEach(el => {
    el.addEventListener('click', e => {
      const delBtn = e.target.closest('.cmd-recent-del');
      if (delBtn) {
        e.stopPropagation();
        const i = parseInt(delBtn.dataset.delHist, 10);
        const h = aiHist[i];
        if (h && h.prompt) {
          _deleteAiHistoryEntry(h.prompt);
          try {
            filterCmdPalette();
            renderPaletteSuggestions();
          } catch (_) {
            el.remove();
          }
        }
        return;
      }
      if (el.dataset.histIdx != null) {
        const h = aiHist[parseInt(el.dataset.histIdx, 10)];
        if (h && h.prompt) askAIFromPalette(h.prompt);
        return;
      }
      const i = parseInt(el.dataset.recentIdx, 10);
      const live = recents[i];
      if (live) {
        closeCmdPalette();
        try {
          live.action();
        } catch (e) {
          console.error(e);
        }
      }
    });
  });
  try {
    lucide.createIcons({
      nodes: [list]
    });
  } catch (_) {}
}

// ── Cmd+I: open palette seeded with the current selection ───────────────
function openAIFocusPalette() {
  let selected = '';
  try {
    selected = String(window.getSelection ? window.getSelection().toString() : '').trim();
  } catch (_) {}
  if (!selected) {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      const start = ae.selectionStart,
        end = ae.selectionEnd;
      if (start != null && end != null && end > start) selected = String(ae.value).slice(start, end);
    }
  }
  openCmdPalette();
  if (!selected) return;
  // Trim to something reasonable for a prompt seed.
  const seed = selected.length > 600 ? selected.slice(0, 600) + '...' : selected;
  setTimeout(() => {
    const input = document.getElementById('cmdPaletteInput');
    if (!input) return;
    input.value = seed;
    filterCmdPalette();
    // Bias selection to the AI fallback row (ask-locally / send-to-CLI).
    const aiIdx = state._cmdFiltered.findIndex(a => a._aiFallback);
    if (aiIdx >= 0) {
      state._cmdSelectedIdx = aiIdx;
      renderCmdPalette();
    }
    input.setSelectionRange(input.value.length, input.value.length);
  }, 60);
}

// ── Shortcut help modal - small cheatsheet overlay ─────────────────────
function openShortcutHelp() {
  let overlay = document.getElementById('shortcutHelpOverlay');
  if (overlay) {
    overlay.remove();
    return;
  }
  overlay = document.createElement('div');
  overlay.id = 'shortcutHelpOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:4500;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove();
  };
  const row = (k, label) => '<div style="display:flex;align-items:center;gap:12px;padding:5px 0;"><span class="sy-kbd" style="min-width:74px;">' + k + '</span><span style="color:var(--subtext1);font-size:12px;">' + label + '</span></div>';
  // Generate the shortcut rows from the live hotkey registry so the cheatsheet
  // always reflects the user's current (possibly rebound) bindings.
  const _hkc = _hotkeyCfg();
  const coreRows = HOTKEY_ACTIONS.filter(a => !_hkc.disabled.has(a.id)).map(a => {
    const c = _effCombo(a, _hkc.bindings);
    return c ? row(comboToDisplay(c), a.label) : '';
  }).join('') + row('Esc', 'Close modals');
  overlay.innerHTML = '<div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:10px;padding:18px 22px;width:560px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);">' + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' + '<i data-lucide="keyboard" style="width:18px;height:18px;color:var(--accent);"></i>' + '<strong style="font-size:13px;">Keyboard shortcuts</strong>' + '<div style="flex:1;"></div>' + '<button onclick="document.getElementById(\'shortcutHelpOverlay\').remove()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>' + '</div>' + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 28px;">' + '<div>' + '<div style="font-size:10px;color:var(--overlay1);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px;">Shortcuts</div>' + coreRows + '</div>' + '<div>' + '<div style="font-size:10px;color:var(--overlay1);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px;">Go to (press g, then...)</div>' + row('g t', 'Terminal') + row('g f', 'Files') + row('g n', 'Notes') + row('g o', 'Orchestrator') + row('g g', 'Git') + row('g s', 'Settings') + row('g b', 'Backlog') + '</div>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  try {
    lucide.createIcons({
      nodes: [overlay]
    });
  } catch (_) {}
}

// ── Palette AI fallback: dispatch a free-text query to the active CLI ───
// History is keyed by active space so each space has its own "Recent prompts".
// Legacy flat key (pre-spaces) is read once and merged into the global slot.
function _aiHistoryKey() {
  return 'symphonee-ai-history-v1:' + (state.activeSpace ? 'space:' + state.activeSpace : 'global');
}
function _migrateLegacyAiHistory() {
  if (_migrateLegacyAiHistory._done) return;
  _migrateLegacyAiHistory._done = true;
  try {
    const legacy = localStorage.getItem('symphonee-ai-history-v1');
    if (!legacy) return;
    const dest = 'symphonee-ai-history-v1:global';
    if (!localStorage.getItem(dest)) localStorage.setItem(dest, legacy);
    localStorage.removeItem('symphonee-ai-history-v1');
  } catch (_) {}
}
function _recordAiHistory(query) {
  _migrateLegacyAiHistory();
  try {
    const key = _aiHistoryKey();
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    const entry = {
      prompt: query,
      at: Date.now(),
      cli: state.activeCli,
      space: state.activeSpace || null
    };
    const next = [entry, ...prev.filter(e => e.prompt !== query)].slice(0, 25);
    localStorage.setItem(key, JSON.stringify(next));
  } catch (_) {}
}
function _readAiHistory() {
  _migrateLegacyAiHistory();
  try {
    return JSON.parse(localStorage.getItem(_aiHistoryKey()) || '[]');
  } catch (_) {
    return [];
  }
}
// Read every AI-history bucket across all spaces, merged and sorted newest-first.
// Used by the "/history all" palette command.
function _readAllAiHistory() {
  _migrateLegacyAiHistory();
  const merged = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('symphonee-ai-history-v1:')) continue;
      const suffix = k.slice('symphonee-ai-history-v1:'.length);
      const space = suffix === 'global' ? null : suffix.startsWith('space:') ? suffix.slice(6) : suffix;
      try {
        const arr = JSON.parse(localStorage.getItem(k) || '[]');
        for (const e of arr) merged.push({
          ...e,
          space: e.space || space
        });
      } catch (_) {}
    }
  } catch (_) {}
  merged.sort((a, b) => (b.at || 0) - (a.at || 0));
  // Dedupe by prompt+space so the same question asked twice in one space only
  // shows up once; but the same prompt in two different spaces stays as two rows.
  const seen = new Set();
  return merged.filter(e => {
    const k = (e.space || 'global') + '::' + e.prompt;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 25);
}
function _deleteAiHistoryEntry(prompt, fromSpace) {
  // If `fromSpace` is given, only delete from that space's bucket. Otherwise
  // delete from the currently-active bucket.
  try {
    const key = fromSpace === undefined ? _aiHistoryKey() : 'symphonee-ai-history-v1:' + (fromSpace ? 'space:' + fromSpace : 'global');
    const prev = JSON.parse(localStorage.getItem(key) || '[]');
    const next = prev.filter(e => e.prompt !== prompt);
    localStorage.setItem(key, JSON.stringify(next));
  } catch (_) {}
}

// Heuristic: is this free-text an informational QUESTION (answer locally) vs a
// TASK to dispatch to an agent? Conservative -- the answer modal has a "send to
// agent" escape hatch for the misfires.
function _looksLikeQuestion(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const first = (t.split(/\s+/)[0] || '').replace(/[^a-z']/g, '');
  const QWORDS = new Set(['how', 'what', "what's", 'whats', 'why', 'when', 'where', 'who', 'which', 'whose', 'whom', 'is', 'are', 'am', 'was', 'were', 'can', 'could', 'should', 'would', 'do', 'does', 'did', 'will', 'explain', 'define']);
  return QWORDS.has(first);
}
state._localAnswerPending = null; // Answer a question locally via Gemma (Mind-grounded) in a modal, instead of
// dispatching an agent. Falls back to dispatch if no local model / on error.
async function answerLocally(question, opts) {
  opts = opts || {};
  const cli = opts.cli || state.activeCli || 'claude';
  const cliLabel = CLI_CONFIG[cli] && CLI_CONFIG[cli].label || cli;
  state._localAnswerPending = {
    question,
    cli
  };
  let overlay = document.getElementById('localAnswerOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'localAnswerOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:4600;display:flex;align-items:flex-start;justify-content:center;padding-top:8vh;font-family:var(--font-ui);';
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML = '<div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:12px;width:680px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 16px 50px rgba(0,0,0,0.55);">' + '<div style="display:flex;align-items:center;gap:8px;padding:13px 18px;border-bottom:1px solid var(--surface1);">' + '<i data-lucide="sparkles" style="width:16px;height:16px;color:var(--accent);"></i>' + '<strong style="font-size:13px;">Quick answer</strong>' + '<span id="localAnswerModel" style="font-size:10px;color:var(--overlay1);">local</span>' + '<div style="flex:1;"></div>' + '<button onclick="document.getElementById(\'localAnswerOverlay\').remove()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>' + '</div>' + '<div style="padding:12px 18px;color:var(--subtext1);font-size:12px;border-bottom:1px solid var(--surface1);">' + esc(question) + '</div>' + '<div id="localAnswerBody" style="padding:16px 18px;overflow:auto;font-size:13px;line-height:1.6;color:var(--text);"><span style="color:var(--subtext0);">Thinking locally...</span></div>' + '<div style="display:flex;align-items:center;gap:10px;padding:11px 18px;border-top:1px solid var(--surface1);">' + '<span style="font-size:11px;color:var(--overlay1);">Answered locally from your Mind.</span>' + '<div style="flex:1;"></div>' + '<button class="hotkey-mini" onclick="_dispatchFromLocalAnswer()">Send to ' + esc(cliLabel) + ' instead</button>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  try {
    lucide.createIcons({
      nodes: [overlay]
    });
  } catch (_) {}
  try {
    const r = await fetch('/api/mind/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        question
      })
    });
    const d = await r.json().catch(() => ({}));
    const bodyEl = document.getElementById('localAnswerBody');
    if (!bodyEl) return; // modal was closed
    if (d && d.ok && d.answer) {
      bodyEl.innerHTML = typeof renderMarkdownToHtml === 'function' ? renderMarkdownToHtml(d.answer) : esc(d.answer).replace(/\n/g, '<br>');
      const me = document.getElementById('localAnswerModel');
      if (me && d.model) me.textContent = d.model + (d.grounded ? ' · grounded' : '');
    } else {
      overlay.remove();
      toast(d && d.reason === 'no-local-model' ? 'No local model installed - sending to agent' : 'Local answer unavailable - sending to agent', 'info');
      askAIFromPalette(question, {
        forceDispatch: true
      });
    }
  } catch (_) {
    if (overlay) overlay.remove();
    toast('Local answer failed - sending to agent', 'info');
    askAIFromPalette(question, {
      forceDispatch: true
    });
  }
}
function _dispatchFromLocalAnswer() {
  const p = state._localAnswerPending;
  const ov = document.getElementById('localAnswerOverlay');
  if (ov) ov.remove();
  if (p) askAIFromPalette(p.question, {
    forceDispatch: true
  });
}
async function askAIFromPalette(query, opts) {
  opts = opts || {};
  if (!query || !query.trim()) {
    closeCmdPalette();
    return;
  }
  // Capture reply context before closing the palette (which clears it).
  const replyParentId = state._pendingFollowupParentId;
  state._pendingFollowupParentId = null;
  state._pendingFollowupPriorPrompt = '';
  closeCmdPalette();
  _recordAiHistory(query.trim());
  const cli = state.activeCli || 'claude';
  const cliLabel = CLI_CONFIG[cli] && CLI_CONFIG[cli].label || cli;
  const fromTag = opts.from || 'palette';
  // Reply mode: route through /followup so the worker sees the prior Q/A.
  if (replyParentId) {
    const parentId = replyParentId;
    try {
      const r = await fetch('/api/orchestrator/followup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          parentTaskId: parentId,
          prompt: query,
          space: state.activeSpace || null
        })
      });
      if (!r.ok) throw new Error(await r.text().catch(() => 'HTTP ' + r.status));
      const body = await r.json().catch(() => ({}));
      const tid = body && (body.taskId || body.id);
      if (tid) _paletteNotifyTasks.add(tid);
      toast('Reply sent - you will be notified when it answers', 'success');
      try {
        orchRefreshTasks();
      } catch (_) {}
    } catch (err) {
      toast('Follow-up failed: ' + (err.message || err), 'error');
    }
    return;
  }
  // Informational questions get a quick local (Gemma, Mind-grounded) answer in a
  // modal instead of spawning an agent. forceDispatch (the modal's escape hatch,
  // and the Re-run action) skips this.
  if (!opts.forceDispatch && _looksLikeQuestion(query)) {
    answerLocally(query.trim(), {
      cli
    });
    return;
  }
  try {
    const res = await fetch('/api/orchestrator/spawn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cli,
        prompt: query,
        from: fromTag,
        space: state.activeSpace || null
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || 'HTTP ' + res.status);
    }
    // Response shape: { taskId, ... }. Track so we can notify on completion.
    let body = null;
    try {
      body = await res.clone().json();
    } catch (_) {}
    const taskId = body && (body.taskId || body.id);
    if (taskId) _paletteNotifyTasks.add(taskId);
    if (taskId) {
      _schedulePaletteDispatchToast(taskId, cli);
    } else {
      toast('Sent to ' + cliLabel + ' - you will be notified when it answers', 'success', {
        rich: true
      });
    }
    try {
      orchRefreshTasks();
    } catch (_) {}
  } catch (err) {
    toast('Failed to dispatch: ' + (err.message || err), 'error');
  }
}
function closeCmdPalette(preserveReplyContext) {
  document.getElementById('cmdPalette').classList.remove('open');
  if (typeof _cmdPaletteExitMode === 'function') _cmdPaletteExitMode();
  // Closing without sending cancels any pending reply context. Callers that
  // are about to run an action which needs the reply context (executeCmdPalette
  // submits via askAIFromPalette which reads _pendingFollowupParentId) pass
  // preserveReplyContext=true so the id isn't nulled before the submit runs.
  if (!preserveReplyContext && state._pendingFollowupParentId) {
    state._pendingFollowupParentId = null;
    state._pendingFollowupPriorPrompt = '';
    try {
      renderReplyChip();
    } catch (_) {}
  }
}
state._cmdSearchTimer = null;
function filterCmdPalette() {
  const inputEl = document.getElementById('cmdPaletteInput');
  const raw = inputEl.value;
  const q = raw.trim().toLowerCase();
  const all = getCmdActions();

  // Detect a known command keyword at the start (slash optional). Show it as
  // a pill overlay so the user has visual feedback they're in command mode.
  const cmdMatch = raw.match(/^(\s*\/?(?:find|search))(\s+|$)/i);
  // If a two-step mode is active, the pill stays lit regardless of what's
  // typed so the user knows Enter will hit the skill.
  if (state._cmdPaletteMode) {
    updatePalettePill(state._cmdPaletteMode);
  } else {
    updatePalettePill(cmdMatch ? cmdMatch[1].replace(/^\s+/, '').replace(/^\//, '') : null);
  }

  // In sticky find-mode, treat the entire input as the query - skip the
  // slash-prefix and other routing below. Empty input just shows the empty
  // hint until the user types.
  if (state._cmdPaletteMode === 'find') {
    if (!q) {
      state._cmdFiltered = [{
        label: 'Type what to find, then press Enter',
        icon: 'search',
        action: () => {},
        category: 'Search'
      }];
      state._cmdSelectedIdx = 0;
      renderCmdPalette();
      return;
    }
    state._cmdFiltered = [{
      label: 'Press Enter to search "' + raw.trim() + '"',
      icon: 'search',
      action: () => runPaletteSearch(raw.trim()),
      category: 'Search'
    }];
    state._cmdSelectedIdx = 0;
    renderCmdPalette();
    return;
  }

  // History command:
  //   "/history"     -> last 25 prompts in the active space
  //   "/history all" -> last 25 prompts across every space (labeled by space)
  const histMatch = raw.match(/^\s*\/?(?:history|recent)(?:\s+(all|global|\*))?\s*$/i);
  if (histMatch) {
    const mode = histMatch[1] ? 'all' : 'current';
    const hist = mode === 'all' ? _readAllAiHistory() : _readAiHistory();
    state._cmdFiltered = hist.length ? hist.map(h => ({
      label: h.prompt,
      icon: 'sparkles',
      action: () => askAIFromPalette(h.prompt),
      category: mode === 'all' ? 'History · ' + (h.space || 'global') : 'History',
      hint: new Date(h.at).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      onDelete: () => {
        _deleteAiHistoryEntry(h.prompt, h.space);
        filterCmdPalette();
      }
    })) : [{
      label: mode === 'all' ? 'No AI history across any space yet' : 'No AI history yet',
      icon: 'clock',
      action: () => {},
      category: 'History'
    }];
    state._cmdSelectedIdx = 0;
    renderCmdPalette();
    return;
  }

  // Search command: "find <query>" or "search <query>" (slash optional)
  // -> hybrid search across notes + learnings
  const findMatch = raw.match(/^\s*\/?(?:find|search)\s+(.+)$/i);
  if (findMatch) {
    const query = findMatch[1];
    state._cmdFiltered = [{
      label: `Searching "${query}"...`,
      icon: 'loader',
      action: () => {},
      category: 'Search'
    }];
    state._cmdSelectedIdx = 0;
    renderCmdPalette();
    runPaletteSearch(query);
    return;
  }

  // Check if user typed a work item ID like #12345 or just 12345 - only when a work-item plugin is active.
  const _hasAdoQuick = !!(state._loadedPlugins || []).some(p => p.id === 'azure-devops');
  const idMatch = _hasAdoQuick ? q.match(/^#?(\d{3,})$/) : null;
  if (idMatch) {
    const id = idMatch[1];
    state._cmdFiltered = all.filter(a => a.label.includes(`#${id}`));
    if (!state._cmdFiltered.some(a => a.label === `#${id}`)) {
      state._cmdFiltered.unshift({
        label: `Open Work Item #${id}`,
        icon: 'external-link',
        action: () => viewWorkItem(parseInt(id)),
        category: 'Work Item'
      });
    }
  } else if (q) {
    state._cmdFiltered = all.filter(a => a.label.toLowerCase().includes(q) || a.category.toLowerCase().includes(q));
  } else {
    state._cmdFiltered = all;
  }

  // AI fallback: if the user typed a query and nothing useful matched, offer
  // to forward it to the active CLI as a prompt. Shown at the bottom when
  // there are a few matches, or as the sole option when nothing matches - so
  // a question like "what's in my inbox" still resolves to a useful action.
  if (q && q.length >= 2 && !findMatch) {
    const queryText = raw.trim();
    // A question gets a quick LOCAL answer (Gemma, grounded in your Mind); a
    // task is dispatched to the active CLI. Label/hint reflect which will happen.
    const isQ = _looksLikeQuestion(queryText);
    const cliLabel = CLI_CONFIG[state.activeCli] && CLI_CONFIG[state.activeCli].label || state.activeCli;
    const already = state._cmdFiltered.some(a => a._aiFallback);
    if (!already) {
      const aiRow = {
        label: (isQ ? 'Answer locally: ' : 'Ask AI: ') + queryText,
        icon: isQ ? 'cpu' : 'sparkles',
        action: () => askAIFromPalette(queryText),
        category: 'AI',
        hint: isQ ? 'Local answer, grounded in your Mind' : 'Send to ' + cliLabel,
        _aiFallback: true
      };
      if (state._cmdFiltered.length === 0) state._cmdFiltered = [aiRow];else state._cmdFiltered.push(aiRow);
    }
  }
  state._cmdSelectedIdx = 0;
  renderCmdPalette();

  // Live search plugins when query is 3+ chars and few plugin results
  clearTimeout(state._cmdSearchTimer);
  if (q.length >= 3) {
    var pluginHits = state._cmdFiltered.filter(a => a.category === 'Wrike' || a.category === 'Builder.io').length;
    if (pluginHits < 3) {
      state._cmdSearchTimer = setTimeout(function () {
        liveSearchPlugins(q);
      }, 300);
    }
  }
}
async function openLearningModal(id) {
  let learning = null;
  try {
    const all = await fetch('/api/learnings').then(r => r.json());
    learning = (Array.isArray(all) ? all : []).find(l => l.id === id);
  } catch (_) {}
  if (!learning) {
    toast('Learning not found: ' + id, 'error');
    return;
  }
  let overlay = document.getElementById('learningOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'learningOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  const cli = learning.cli ? `<span style="font-size:10px;padding:2px 6px;background:var(--surface2);color:var(--subtext0);border-radius:3px;">cli: ${escapeHtml(learning.cli)}</span>` : '';
  const synced = learning.synced ? '<span style="font-size:10px;color:var(--green);" title="Synced to shared learnings repo">synced</span>' : '<span style="font-size:10px;color:var(--subtext0);" title="Local only">local</span>';
  overlay.innerHTML = `
    <div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:var(--radius);padding:18px 22px;width:80vw;max-width:780px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
        <i data-lucide="book-marked" style="width:18px;height:18px;color:var(--accent);"></i>
        <strong style="font-size:14px;">Learning</strong>
        <span style="font-size:10px;padding:2px 6px;background:var(--surface2);color:var(--subtext0);border-radius:3px;">${escapeHtml(learning.category || 'general')}</span>
        ${cli}
        ${synced}
        <div style="flex:1;"></div>
        <span style="font-size:10px;color:var(--subtext0);font-family:var(--font-mono);">id: ${escapeHtml(learning.id)}</span>
        <button onclick="document.getElementById('learningOverlay').remove()" style="font-size:12px;padding:5px 12px;background:var(--surface1);border:1px solid var(--surface2);border-radius:4px;color:var(--text);cursor:pointer;">Close</button>
      </div>
      <div style="overflow-y:auto;flex:1;min-height:0;">
        <div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:14px;word-wrap:break-word;">${escapeHtml(learning.summary || '')}</div>
        ${learning.detail ? `<div style="font-size:12px;color:var(--subtext0);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Detail</div><pre style="background:var(--mantle);border:1px solid var(--surface2);border-radius:4px;padding:12px;color:var(--text);font:12px var(--font-mono);white-space:pre-wrap;line-height:1.5;margin:0;">${escapeHtml(learning.detail)}</pre>` : ''}
        ${learning.source ? `<div style="margin-top:14px;font-size:11px;color:var(--subtext0);">Source: ${escapeHtml(learning.source)} · ${escapeHtml(learning.addedAt || '')}</div>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}
state._repoMapEditor = null;
state._repoMapMarkdownText = '';
state._repoMapView = 'code'; // 'code' | 'preview'
async function openRepoMapModal() {
  let overlay = document.getElementById('repoMapOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'repoMapOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  overlay.innerHTML = `
    <div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:var(--radius);padding:14px 16px;width:92vw;max-width:1100px;height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-shrink:0;">
        <i data-lucide="map" style="width:18px;height:18px;color:var(--accent);"></i>
        <strong style="font-size:15px;">Repo Map</strong>
        <select id="repoMapRepo" style="margin-left:8px;padding:5px 8px;background:var(--surface1);border:1px solid var(--surface2);border-radius:4px;color:var(--text);font:12px var(--font-ui);outline:none;"></select>
        <select id="repoMapBudget" style="padding:5px 8px;background:var(--surface1);border:1px solid var(--surface2);border-radius:4px;color:var(--text);font:12px var(--font-ui);outline:none;">
          <option value="2000">~2k tokens</option>
          <option value="4000" selected>~4k tokens</option>
          <option value="8000">~8k tokens</option>
          <option value="16000">~16k tokens</option>
        </select>
        <button onclick="loadRepoMapInto()" style="font-size:12px;padding:5px 12px;background:var(--surface1);border:1px solid var(--surface2);color:var(--text);border-radius:4px;cursor:pointer;">Refresh</button>
        <div style="display:flex;border:1px solid var(--surface2);border-radius:4px;overflow:hidden;">
          <button onclick="setRepoMapView('code')" id="repoMapBtnCode" style="font-size:12px;padding:5px 12px;background:var(--accent);border:none;color:#000;cursor:pointer;font-weight:600;">Code</button>
          <button onclick="setRepoMapView('preview')" id="repoMapBtnPreview" style="font-size:12px;padding:5px 12px;background:var(--surface1);border:none;border-left:1px solid var(--surface2);color:var(--text);cursor:pointer;">Preview</button>
        </div>
        <div style="flex:1;"></div>
        <button onclick="copyRepoMap()" style="font-size:12px;padding:5px 12px;background:var(--surface1);border:1px solid var(--surface2);color:var(--text);border-radius:4px;cursor:pointer;">Copy</button>
        <button onclick="saveRepoMapAsNote()" style="font-size:12px;padding:5px 12px;background:var(--surface1);border:1px solid var(--surface2);color:var(--text);border-radius:4px;cursor:pointer;" title="Save this repo map as a Symphonee note">Save as Note</button>
        <button onclick="sendRepoMapToAi()" style="font-size:12px;padding:5px 12px;background:var(--accent);border:1px solid var(--surface2);color:#000;font-weight:600;border-radius:4px;cursor:pointer;" title="Send the map to the AI in the terminal">Send to AI</button>
        <button onclick="closeRepoMapModal()" style="font-size:12px;padding:5px 12px;background:var(--surface1);border:1px solid var(--surface2);border-radius:4px;color:var(--text);cursor:pointer;">Close</button>
      </div>
      <div id="repoMapEditor" style="flex:1;border:1px solid var(--surface2);border-radius:4px;overflow:hidden;display:block;"></div>
      <div id="repoMapPreview" style="flex:1;border:1px solid var(--surface2);border-radius:4px;overflow:auto;background:var(--mantle);padding:18px 22px;color:var(--text);display:none;line-height:1.55;font-size:13px;"></div>
    </div>`;
  document.body.appendChild(overlay);
  try {
    const repos = await fetch('/api/repos').then(r => r.json());
    const spaces = window._spacesCache || (await fetch('/api/spaces').then(r => r.json()).catch(() => ({})));
    const ctx = await fetch('/api/ui/context').then(r => r.json());
    const sel = document.getElementById('repoMapRepo');
    sel.innerHTML = _repoNamesForSpace(repos || {}, spaces || {}, state.activeSpace).map(n => `<option value="${escapeHtml(n)}" ${n === ctx.activeRepo ? 'selected' : ''}>${escapeHtml(n)}${n === ctx.activeRepo ? ' (active)' : ''}</option>`).join('');
  } catch (_) {}
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  // Mount Monaco
  try {
    if (typeof loadMonaco === 'function') await loadMonaco();
    if (typeof monaco !== 'undefined') {
      state._repoMapEditor = monaco.editor.create(document.getElementById('repoMapEditor'), {
        value: 'Loading...',
        language: 'markdown',
        theme: 'symphonee',
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
        minimap: {
          enabled: false
        },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        automaticLayout: true,
        readOnly: true,
        lineNumbers: 'off',
        padding: {
          top: 10
        }
      });
    }
  } catch (e) {
    console.warn('repo map monaco mount failed', e);
  }
  state._repoMapView = 'code';
  loadRepoMapInto();
}
function closeRepoMapModal() {
  if (state._repoMapEditor) {
    try {
      state._repoMapEditor.dispose();
    } catch (_) {}
    state._repoMapEditor = null;
  }
  const o = document.getElementById('repoMapOverlay');
  if (o) o.remove();
}

// Open the Skills view (a Mind sub-tab). Skills are part of the brain, so they
// live under Mind as a proper view, not a pop-up modal.
function openMindSkills() {
  if (typeof closeCmdPalette === 'function') closeCmdPalette();
  switchTab('mind');
  setTimeout(() => {
    try {
      if (window.MindUI) MindUI.setView('skills');
    } catch (_) {}
  }, 80);
}
function setRepoMapView(view) {
  state._repoMapView = view;
  const ed = document.getElementById('repoMapEditor');
  const pv = document.getElementById('repoMapPreview');
  const bc = document.getElementById('repoMapBtnCode');
  const bp = document.getElementById('repoMapBtnPreview');
  if (view === 'preview') {
    ed.style.display = 'none';
    pv.style.display = '';
    pv.innerHTML = renderMarkdownToHtml(state._repoMapMarkdownText);
    bc.style.background = 'var(--surface1)';
    bc.style.color = 'var(--text)';
    bc.style.fontWeight = '400';
    bp.style.background = 'var(--accent)';
    bp.style.color = '#000';
    bp.style.fontWeight = '600';
  } else {
    ed.style.display = '';
    pv.style.display = 'none';
    bc.style.background = 'var(--accent)';
    bc.style.color = '#000';
    bc.style.fontWeight = '600';
    bp.style.background = 'var(--surface1)';
    bp.style.color = 'var(--text)';
    bp.style.fontWeight = '400';
    if (state._repoMapEditor) state._repoMapEditor.layout();
  }
}
async function loadRepoMapInto() {
  const repo = document.getElementById('repoMapRepo').value;
  const budget = document.getElementById('repoMapBudget').value;
  if (state._repoMapEditor) state._repoMapEditor.setValue(`Generating map for ${repo} (~${budget} tokens)...`);
  try {
    const r = await fetch('/api/repo/map?repo=' + encodeURIComponent(repo) + '&budget=' + encodeURIComponent(budget));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state._repoMapMarkdownText = await r.text();
    if (state._repoMapEditor) state._repoMapEditor.setValue(state._repoMapMarkdownText);
    if (state._repoMapView === 'preview') {
      document.getElementById('repoMapPreview').innerHTML = renderMarkdownToHtml(state._repoMapMarkdownText);
    }
  } catch (e) {
    state._repoMapMarkdownText = 'Failed: ' + e.message;
    if (state._repoMapEditor) state._repoMapEditor.setValue(state._repoMapMarkdownText);
  }
}
async function copyRepoMap() {
  try {
    await navigator.clipboard.writeText(state._repoMapMarkdownText);
    toast('Copied to clipboard', 'success');
  } catch (_) {
    toast('Copy failed', 'error');
  }
}
async function saveRepoMapAsNote() {
  if (!state._repoMapMarkdownText || state._repoMapMarkdownText.startsWith('Failed:') || state._repoMapMarkdownText.startsWith('Generating')) {
    toast('No repo map to save yet', 'error');
    return;
  }
  const repo = document.getElementById('repoMapRepo')?.value || 'repo';
  const ts = new Date().toISOString().slice(0, 10);
  const defaultName = `repo-map-${repo}-${ts}`.replace(/[^a-zA-Z0-9._-]/g, '-');
  const name = await customPrompt('Save Repo Map as Note', defaultName);
  if (!name) return;
  try {
    const createRes = await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name
      })
    });
    const created = await createRes.json();
    if (created.error && !/exists/i.test(created.error)) {
      toast(created.error, 'error');
      return;
    }
    const saveRes = await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: created.name || name,
        content: state._repoMapMarkdownText
      })
    });
    const saved = await saveRes.json();
    if (saved.error) {
      toast(saved.error, 'error');
      return;
    }
    toast(`Saved as note "${created.name || name}"`, 'success');
    if (typeof loadNotesList === 'function') loadNotesList();
  } catch (_) {
    toast('Failed to save note', 'error');
  }
}
async function sendRepoMapToAi() {
  if (!state._repoMapMarkdownText || state._repoMapMarkdownText.startsWith('Failed:') || state._repoMapMarkdownText.startsWith('Generating')) {
    toast('No repo map to send yet', 'error');
    return;
  }
  const repo = document.getElementById('repoMapRepo')?.value || '';
  const prompt = `Analyze the repository "${repo}" using the repo map below as ground truth for structure before diving into specific files. When I ask follow-up questions, ground your answers in this map.\n\n---\n${state._repoMapMarkdownText}\n---`;
  closeRepoMapModal();
  askAi(prompt);
}

// Sidebar "Analyze Repo" action: fetch the repo map for the active repo,
// then send it to the AI with an analyze prompt. Bypasses the modal so the
// flow is one click for the common case.
async function analyzeActiveRepo() {
  let repo = '';
  try {
    repo = (await fetch('/api/ui/context').then(r => r.json())).activeRepo || '';
  } catch (_) {}
  if (!repo) {
    toast('No active repo selected', 'error');
    return;
  }
  toast(`Generating repo map for ${repo}...`, 'info');
  let md = '';
  try {
    const r = await fetch('/api/repo/map?repo=' + encodeURIComponent(repo) + '&budget=4000');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    md = await r.text();
  } catch (e) {
    toast('Repo map failed: ' + e.message, 'error');
    return;
  }
  state._repoMapMarkdownText = md;
  const prompt = `Analyze the repository "${repo}" using the repo map below as ground truth for structure before diving into specific files. When I ask follow-up questions, ground your answers in this map.\n\n---\n${md}\n---`;
  askAi(prompt);
}

// Tiny markdown -> HTML renderer (handles the subset our repo maps emit)
function renderMarkdownToHtml(md) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code style="background:var(--surface1);padding:1px 5px;border-radius:3px;font-size:12px;">$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>').replace(/_([^_]+)_/g, '<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--accent);text-decoration:underline;">$1</a>');
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const line of lines) {
    if (/^### /.test(line)) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('<h3 style="margin:18px 0 8px;font-size:14px;color:var(--text);">' + inline(line.slice(4)) + '</h3>');
    } else if (/^## /.test(line)) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('<h2 style="margin:22px 0 10px;font-size:16px;color:var(--text);border-bottom:1px solid var(--surface2);padding-bottom:4px;">' + inline(line.slice(3)) + '</h2>');
    } else if (/^# /.test(line)) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('<h1 style="margin:0 0 14px;font-size:20px;color:var(--text);">' + inline(line.slice(2)) + '</h1>');
    } else if (/^- /.test(line)) {
      if (!inList) {
        out.push('<ul style="margin:6px 0 12px 20px;">');
        inList = true;
      }
      out.push('<li style="margin:3px 0;">' + inline(line.slice(2)) + '</li>');
    } else if (line.trim() === '') {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('');
    } else {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('<p style="margin:6px 0;">' + inline(line) + '</p>');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

// Show a small badge below the input when a known command keyword is
// detected. Non-overlapping with the input itself, so it can't break the
// input's layout, padding, scroll behavior, or cursor handling.
function updatePalettePill(keyword) {
  const input = document.getElementById('cmdPaletteInput');
  const badge = document.getElementById('cmdPaletteCmdBadge');
  const badgeText = document.getElementById('cmdPaletteCmdBadgeText');
  if (!input || !badge) return;
  if (!keyword) {
    badge.style.display = 'none';
    input.style.borderLeft = '';
    return;
  }
  badgeText.textContent = keyword;
  badge.style.display = 'flex';
  // Subtle accent on the input's left edge as a secondary cue.
  input.style.borderLeft = '3px solid var(--accent)';
  if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
}
async function runPaletteSearch(query) {
  const input = document.getElementById('cmdPaletteInput');
  if (!input) return;
  // Bail if the user has typed past this query (race protection)
  const cur = input.value.trim().toLowerCase();
  if (!/^\/?(?:find|search)\s+/i.test(cur)) return;
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(query) + '&limit=20');
    const data = await r.json();
    if (!data.results || !data.results.length) {
      state._cmdFiltered = [{
        label: `No matches for "${query}"`,
        icon: 'x-circle',
        action: () => {},
        category: 'Search'
      }];
      state._cmdSelectedIdx = 0;
      renderCmdPalette();
      return;
    }
    state._cmdFiltered = data.results.map(x => ({
      label: `${x.kind === 'learning' ? '[learning] ' : ''}${x.title}`,
      icon: x.kind === 'learning' ? 'book-marked' : 'file-text',
      hint: (x.snippet || '').slice(0, 80),
      category: 'Search',
      action: () => {
        if (x.kind === 'note') openNote(x.id.replace(/^note:/, ''));else openLearningModal(x.id.replace(/^learning:/, ''));
      }
    }));
    state._cmdSelectedIdx = 0;
    renderCmdPalette();
  } catch (_) {
    state._cmdFiltered = [{
      label: 'Search failed',
      icon: 'alert-circle',
      action: () => {},
      category: 'Search'
    }];
    state._cmdSelectedIdx = 0;
    renderCmdPalette();
  }
}
async function liveSearchPlugins(q) {
  if (!state._loadedPlugins) return;
  var currentQ = document.getElementById('cmdPaletteInput').value.toLowerCase().trim();
  if (currentQ !== q) return; // user typed something else

  var newItems = [];

  // Wrike live search
  if (state._loadedPlugins.some(function (p) {
    return p.id === 'wrike';
  })) {
    try {
      var tasks = await (await fetch('/api/plugins/wrike/tasks/search?q=' + encodeURIComponent(q) + '&limit=10')).json();
      if (Array.isArray(tasks)) {
        var existing = new Set(state._cmdFiltered.map(a => a.label));
        tasks.forEach(function (t) {
          if (!existing.has(t.title)) {
            newItems.push({
              label: t.title,
              icon: 'check-square',
              action: function () {
                openPluginTab('plugin-wrike-board');
                var iframes = document.querySelectorAll('iframe[data-plugin-id="wrike"]');
                iframes.forEach(function (f) {
                  f.contentWindow.postMessage({
                    __symphonee: true,
                    type: 'viewTask',
                    taskId: t.id
                  }, location.origin);
                });
              },
              category: 'Wrike'
            });
          }
        });
      }
    } catch (_) {}
  }
  if (newItems.length) {
    // Re-check the query hasn't changed
    currentQ = document.getElementById('cmdPaletteInput').value.toLowerCase().trim();
    if (currentQ !== q) return;
    state._cmdFiltered = state._cmdFiltered.concat(newItems);
    renderCmdPalette();
  }
}
function renderCmdPalette() {
  const list = document.getElementById('cmdPaletteList');
  if (state._cmdFiltered.length === 0) {
    list.innerHTML = '<div class="cmd-palette-empty">No matching commands</div>';
    return;
  }
  list.innerHTML = state._cmdFiltered.map((cmd, i) => `
    <div class="cmd-palette-item ${i === state._cmdSelectedIdx ? 'selected' : ''}" data-idx="${i}">
      <i data-lucide="${cmd.icon}"></i>
      <span class="cmd-label">${esc(cmd.label)}</span>
      ${cmd.hint ? `<span class="cmd-hint">${cmd.hint}</span>` : ''}
      <span class="cmd-category">${cmd.category}</span>
      ${cmd.onDelete ? `<button class="cmd-del" data-del="${i}" title="Remove from history"><i data-lucide="x" style="width:11px;height:11px;"></i></button>` : ''}
    </div>
  `).join('');
  lucide.createIcons();
  // Bind events after render (avoids innerHTML replacement killing click targets)
  list.querySelectorAll('.cmd-palette-item').forEach(el => {
    el.addEventListener('mouseenter', () => {
      list.querySelectorAll('.cmd-palette-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      state._cmdSelectedIdx = parseInt(el.dataset.idx);
    });
    el.addEventListener('click', e => {
      if (e.target.closest('.cmd-del')) return; // handled below
      executeCmdPalette(parseInt(el.dataset.idx));
    });
  });
  list.querySelectorAll('.cmd-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.del);
      const row = state._cmdFiltered[idx];
      if (row && typeof row.onDelete === 'function') {
        row.onDelete();
      }
    });
  });
  // Scroll selected into view
  const selected = list.querySelector('.selected');
  if (selected) selected.scrollIntoView({
    block: 'nearest'
  });
}

// Two-step slash skills (e.g. "find"): pressing Enter on the bare keyword
// enters a sticky mode where the next Enter executes the skill against
// whatever the user typed next. Escape or clearing the input exits the mode.
state._cmdPaletteMode = null; // 'find' | null
function _cmdPaletteEnterMode(mode) {
  state._cmdPaletteMode = mode;
  const input = document.getElementById('cmdPaletteInput');
  if (input) {
    input.value = '';
    input.placeholder = mode === 'find' ? 'Search notes + learnings...' : input.placeholder;
    input.focus();
  }
  if (typeof updatePalettePill === 'function') updatePalettePill(mode);
  try {
    filterCmdPalette();
  } catch (_) {}
}
function _cmdPaletteExitMode() {
  state._cmdPaletteMode = null;
  const input = document.getElementById('cmdPaletteInput');
  if (input) input.placeholder = 'Ask AI, or type a command...';
  if (typeof updatePalettePill === 'function') updatePalettePill(null);
}
function cmdPaletteKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state._cmdSelectedIdx = Math.min(state._cmdSelectedIdx + 1, state._cmdFiltered.length - 1);
    renderCmdPalette();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state._cmdSelectedIdx = Math.max(state._cmdSelectedIdx - 1, 0);
    renderCmdPalette();
  } else if (e.key === 'Enter') {
    const input = document.getElementById('cmdPaletteInput');
    const raw = (input?.value || '').trim();

    // Bare skill keyword: "find" or "/find" -> enter find-mode and wait for query.
    if (!state._cmdPaletteMode && /^\/?(?:find|search)$/i.test(raw)) {
      e.preventDefault();
      _cmdPaletteEnterMode('find');
      return;
    }

    // In find-mode, Enter runs the search against the current input.
    if (state._cmdPaletteMode === 'find' && raw) {
      e.preventDefault();
      runPaletteSearch(raw);
      return;
    }
    e.preventDefault();
    executeCmdPalette(state._cmdSelectedIdx);
  } else if (e.key === 'Escape') {
    if (state._cmdPaletteMode) {
      _cmdPaletteExitMode();
      return;
    }
    closeCmdPalette();
  }
}
function executeCmdPalette(idx) {
  const cmd = state._cmdFiltered[idx];
  if (!cmd) return;
  // Record the pick into the recent-commands queue so future palette opens
  // surface it at the top. Skip ephemeral entries (search results, "Ask AI"
  // prompts) - those belong in their own history if we ever add one.
  try {
    if (cmd.label && cmd.category !== 'Search' && !/^Ask AI:/.test(cmd.label)) {
      const key = 'symphonee-palette-recents-v1';
      const prev = JSON.parse(localStorage.getItem(key) || '[]');
      const entry = {
        label: cmd.label,
        icon: cmd.icon,
        category: cmd.category,
        hint: cmd.hint
      };
      const next = [entry, ...prev.filter(e => e.label !== entry.label)].slice(0, 5);
      localStorage.setItem(key, JSON.stringify(next));
    }
  } catch (_) {}
  // Keep any pending reply context alive so cmd.action() (e.g. askAIFromPalette
  // for the "Ask AI" entry) can route to /followup instead of spawning a new
  // agent. The action captures + clears it once consumed.
  closeCmdPalette(true);
  cmd.action();
}
function _getRecentPaletteActions() {
  try {
    const key = 'symphonee-palette-recents-v1';
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(stored) || !stored.length) return [];
    const all = getCmdActions();
    // Reconnect each stored stub to a live action by matching its label. If
    // the command is no longer available (repo removed, plugin uninstalled),
    // silently skip it.
    const out = [];
    for (const s of stored) {
      const live = all.find(a => a.label === s.label);
      if (live) out.push(live);
    }
    return out;
  } catch (_) {
    return [];
  }
}

// ── Public surface ──────────────────────────────────────────────────────────
// Palette open/close/filter/keydown reached from index.html + keyboard hotkeys;
// the repo-map modal + quick-ask reached from index.html and generated onclick.
// The search/render/dispatch helpers stay private.
window.loadPluginCmdItems = loadPluginCmdItems;
window.openCmdPalette = openCmdPalette;
window.openAIFocusPalette = openAIFocusPalette;
window.openShortcutHelp = openShortcutHelp;
window._readAiHistory = _readAiHistory;
window._dispatchFromLocalAnswer = _dispatchFromLocalAnswer;
window.askAIFromPalette = askAIFromPalette;
window.closeCmdPalette = closeCmdPalette;
window.filterCmdPalette = filterCmdPalette;
window.openRepoMapModal = openRepoMapModal;
window.closeRepoMapModal = closeRepoMapModal;
window.setRepoMapView = setRepoMapView;
window.loadRepoMapInto = loadRepoMapInto;
window.copyRepoMap = copyRepoMap;
window.saveRepoMapAsNote = saveRepoMapAsNote;
window.sendRepoMapToAi = sendRepoMapToAi;
window.analyzeActiveRepo = analyzeActiveRepo;
window._cmdPaletteEnterMode = _cmdPaletteEnterMode;
window.cmdPaletteKeydown = cmdPaletteKeydown;