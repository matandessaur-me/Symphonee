var state = {};
// Main dashboard renderer logic. Extracted verbatim from the index.html inline
// <script>; loaded at the same position via <script src> so execution order and
// global scope are unchanged.
// ── CLI config ──────────────────────────────────────────────────────────
const CLI_CONFIG = {
  claude: {
    cmd: 'claude',
    label: 'Claude Code'
  },
  gemini: {
    cmd: 'gemini',
    label: 'Gemini CLI'
  },
  copilot: {
    cmd: 'copilot',
    label: 'Copilot CLI'
  },
  codex: {
    cmd: 'codex',
    label: 'Codex CLI'
  },
  grok: {
    cmd: 'grok',
    label: 'Grok Code'
  },
  qwen: {
    cmd: 'qwen',
    label: 'Qwen Code'
  }
};
// Exposed on window so the extracted notifications module (loaded after app.js)
// can read the CLI label/colour config by bare name. terminals.js owns it.
window.CLI_CONFIG = CLI_CONFIG;

// Terminal themes keyed by visual theme id (decoupled from AI selection)
const TERM_THEMES = {
  'warm-metallic': {
    background: '#1e1e1c',
    foreground: '#e8e4dc',
    cursor: '#d97757',
    selectionBackground: '#36363280'
  },
  'industrial-blue': {
    background: '#1b1b1f',
    foreground: '#e3e3e8',
    cursor: '#078efa',
    selectionBackground: '#2b2b3180'
  },
  'futuristic-green': {
    background: '#202123',
    foreground: '#ececf1',
    cursor: '#10a37f',
    selectionBackground: '#34354180'
  },
  'arctic-frost': {
    background: '#f4f6f8',
    foreground: '#1a2332',
    cursor: '#2563eb',
    selectionBackground: '#c5cdd680'
  },
  'warm-sand': {
    background: '#f8f5f0',
    foreground: '#2d2418',
    cursor: '#c2703e',
    selectionBackground: '#d0c5b580'
  }
};
// Exposed on window so the extracted themes module (loaded after app.js) can read
// the terminal colour schemes by bare name. terminals.js stays the owner.
window.TERM_THEMES = TERM_THEMES;
state.activeThemeId = 'industrial-blue';
function getActiveTermTheme() {
  const base = TERM_THEMES['_active'] || TERM_THEMES[state.activeThemeId] || TERM_THEMES['industrial-blue'];
  // Mirror --mantle so the terminal background blends with the sidebar,
  // intel panel, center padding, and rails (no visual seam around xterm).
  try {
    const mantle = getComputedStyle(document.documentElement).getPropertyValue('--mantle').trim();
    if (mantle) return Object.assign({}, base, {
      background: mantle
    });
  } catch (_) {}
  return base;
}
state.activeCli = localStorage.getItem('symphonee-cli') || 'claude'; // Per-shell AI state: termId -> { cli: string, launched: boolean }
const termAiState = new Map();
// Legacy compat getter
Object.defineProperty(window, 'aiLaunched', {
  get: () => {
    const s = termAiState.get(state.activeTermId);
    return s ? s.launched : false;
  }
});
state.ws = null;
state.workItems = [];
state.hasMoreClosed = false;
state.totalClosedCount = 0;
state.totalClosedCapped = false;
state.closedItemsLimit = 10;
state._activeWiCacheKey = '';
state.currentWiDetail = null;
state.configData = {};
state.lastCols = 0;
state.lastRows = 0;
state.fitDebounce = null;
state.reconnectTimer = null; // ── Multi-Terminal System ────────────────────────────────────────────────
const termInstances = new Map(); // termId -> { term, fitAddon, container }
state.activeTermId = 'main';
state._renamingTab = false; // while true, switchTerminal must not steal focus back to the xterm (it would blur the inline rename field)
state.termCounter = 0;
function createTermOpts() {
  return {
    allowTransparency: false,
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize: 14,
    fontWeight: '400',
    fontWeightBold: '600',
    lineHeight: 1.15,
    scrollback: 10000,
    allowProposedApi: true,
    minimumContrastRatio: 1,
    drawBoldTextInBrightColors: false,
    theme: getActiveTermTheme()
  };
}
function createTermInstance(termId, label) {
  // Create container div
  let container = document.getElementById(`term-${termId}`);
  if (!container) {
    container = document.createElement('div');
    container.id = `term-${termId}`;
    container.className = 'term-instance';
    document.getElementById('termContainers').appendChild(container);
  }

  // Create xterm
  const term = new Terminal(createTermOpts());
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((event, url) => {
    event.preventDefault();
    openExternal(url);
  }));
  const u11 = new Unicode11Addon.Unicode11Addon();
  term.loadAddon(u11);
  term.unicode.activeVersion = '11';
  term.open(container);
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
    });
    term.loadAddon(webgl);
  } catch (_) {}

  // Let modifier-only keys pass through to document handlers (voice recording uses Ctrl+Shift).
  // Also bubble specific UI shortcuts (Ctrl+K/I/./? and their Meta counterparts) so they reach
  // the global keydown listener instead of being swallowed by the terminal.
  term.attachCustomKeyEventHandler(e => {
    if (e.key === 'Control' || e.key === 'Shift') return false;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = (e.key || '').toLowerCase();
      // Let a combo bound to an allow-in-input hotkey that WOULD fire (command
      // palette, AI focus, help, etc. -- including REBOUND ones) bubble to the
      // global hub instead of going to the PTY. The when() check means context
      // shortcuts (e.g. note Ctrl+S) do NOT suppress the terminal's own keys.
      try {
        const combo = eventToCombo(e);
        const act = combo && state._hotkeyMap.get(combo);
        if (act && act.allowInInput && (act.when ? act.when() : true)) return false;
      } catch (_) {}
      // Ctrl/Cmd+V: paste the clipboard into the PTY. Without this xterm sends a
      // raw ^V (0x16) and nothing useful happens. preventDefault suppresses the
      // browser's native paste so the 'paste' listener below does not also fire
      // (no double paste); return false keeps xterm from processing the key.
      // Guard on keydown -- the handler also fires on keyup.
      if (k === 'v' && e.type === 'keydown') {
        e.preventDefault();
        pasteIntoTerm();
        return false;
      }
    }
    return true;
  });

  // Input
  term.onData(data => {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
      type: 'input',
      termId,
      data
    }));
  });

  // Send clipboard text to the PTY as input. Shared by Ctrl/Cmd+V, the
  // right-click menu, and the paste event (Win+V, dictation tools like Wispr
  // Flow that inject text via the clipboard).
  async function pasteIntoTerm() {
    try {
      const text = await navigator.clipboard.readText();
      if (text && state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
        type: 'input',
        termId,
        data: text
      }));
    } catch (_) {}
  }

  // Right-click: copy the selection if there is one, otherwise paste.
  container.addEventListener('contextmenu', async e => {
    e.preventDefault();
    e.stopPropagation();
    const sel = term.getSelection();
    if (sel) {
      try {
        await navigator.clipboard.writeText(sel);
      } catch (_) {}
    } else {
      pasteIntoTerm();
    }
  });

  // Native paste events: Win+V clipboard history, middle-click paste, and
  // dictation tools (e.g. Wispr Flow) that inject via the clipboard. This used
  // to just block the event, which silently broke ALL keyboard/voice paste in
  // the terminal. Forward the event's clipboard text to the PTY instead.
  // (Ctrl/Cmd+V is handled in the key handler above, which preventDefaults, so
  // it does not also reach here -- no double paste.)
  container.addEventListener('paste', e => {
    e.preventDefault();
    e.stopPropagation();
    let text = '';
    try {
      text = (e.clipboardData || window.clipboardData).getData('text');
    } catch (_) {}
    if (text && state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
      type: 'input',
      termId,
      data: text
    }));
  });
  termInstances.set(termId, {
    term,
    fitAddon,
    container,
    label: label || termId
  });

  // Add tab if not main (main tab already exists in HTML)
  if (termId !== 'main') {
    const tabsEl = document.getElementById('termTabs');
    const addBtn = tabsEl.querySelector('.term-tab-add');
    const tab = document.createElement('div');
    tab.className = 'term-tab';
    tab.dataset.term = termId;
    tab.title = 'Double-click to rename';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'term-tab-name';
    nameSpan.textContent = label || termId;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'term-tab-close';
    closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    closeBtn.onpointerdown = e => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeTerminal(termId);
    };
    tab.appendChild(nameSpan);
    tab.appendChild(closeBtn);
    tab.addEventListener('click', e => {
      if (!e.target.closest('.term-tab-close')) switchTerminal(termId);
    });
    tabsEl.insertBefore(tab, addBtn);
    enableTabRename(tab, termId);
  }
  return {
    term,
    fitAddon
  };
}
function switchTerminal(termId) {
  state.activeTermId = termId;
  document.querySelectorAll('.term-tab').forEach(el => el.classList.toggle('active', el.dataset.term === termId));
  document.querySelectorAll('.term-instance').forEach(el => el.classList.toggle('active', el.id === `term-${termId}`));
  const inst = termInstances.get(termId);
  if (inst) {
    // Double-rAF: first frame applies CSS layout, second frame guarantees
    // the container has its final dimensions before we fit the terminal.
    // Without this, newly-created tabs get fit() with 0x0 container size.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          inst.fitAddon.fit();
          // Always send resize to server so the PTY matches xterm dimensions
          const cols = inst.term.cols;
          const rows = inst.term.rows;
          state.lastCols = cols;
          state.lastRows = rows;
          if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
            type: 'resize',
            termId,
            cols,
            rows
          }));
        } catch (_) {}
        if (!state._renamingTab) inst.term.focus();
      });
    });
  }
  // Sync AI controls for the newly-active shell
  if (typeof syncAiControls === 'function') syncAiControls();
}
function getNextShellNumber() {
  // Find the lowest available shell number (main = 1)
  const used = new Set([1]);
  for (const [id, inst] of termInstances) {
    if (id === 'main') continue;
    const m = inst.label.match(/^Shell (\d+)$/);
    if (m) used.add(parseInt(m[1]));
  }
  let n = 2;
  while (used.has(n)) n++;
  return n;
}
function renumberShells() {
  // After closing a shell, renumber remaining shells sequentially
  let num = 2;
  for (const [id, inst] of termInstances) {
    if (id === 'main') continue;
    if (inst.label.startsWith('Shell ')) {
      inst.label = `Shell ${num}`;
      const tab = document.querySelector(`.term-tab[data-term="${id}"] span`);
      if (tab) tab.textContent = inst.label;
      num++;
    }
  }
}
function addTerminal(label, cwd) {
  state.termCounter++;
  const termId = `term-${state.termCounter}`;
  const name = label || `Shell ${getNextShellNumber()}`;
  // Capture known-good dimensions from the current active terminal BEFORE
  // switching, because the new terminal hasn't been laid out yet.
  const cols = state.lastCols || 80;
  const rows = state.lastRows || 24;
  createTermInstance(termId, name);
  switchTerminal(termId);
  // Create server PTY with the known-good dimensions; switchTerminal's
  // double-rAF will fit() the xterm and send a resize once layout is done.
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({
      type: 'create-term',
      termId,
      cwd,
      cols,
      rows,
      label: name
    }));
  }
  return termId;
}
function closeTerminal(termId) {
  if (termId === 'main') return; // can't close main
  termAiState.delete(termId);
  const inst = termInstances.get(termId);
  if (inst) {
    inst.term.dispose();
    inst.container.remove();
    termInstances.delete(termId);
  }
  // Remove tab
  const tab = document.querySelector(`.term-tab[data-term="${termId}"]`);
  if (tab) tab.remove();
  // Kill server PTY
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
    type: 'kill-term',
    termId
  }));
  // Renumber remaining shells
  renumberShells();
  // Switch to main
  if (state.activeTermId === termId) switchTerminal('main');
  // Refresh orchestrator agent list
  if (typeof orchRefreshAgents === 'function') orchRefreshAgents();
}

// Inline-rename a terminal tab: double-click the name to edit it. Enter or blur
// commits, Escape cancels. The custom label is stored on the term instance;
// renumberShells() only renumbers auto "Shell N" labels, so custom names stick.
function enableTabRename(tabEl, termId) {
  if (!tabEl) return;
  const nameEl = tabEl.querySelector('.term-tab-name');
  if (!nameEl) return;
  tabEl.addEventListener('dblclick', e => {
    e.preventDefault();
    e.stopPropagation();
    if (nameEl.getAttribute('contenteditable') === 'true') return;
    const prev = nameEl.textContent;
    let done = false;
    state._renamingTab = true; // keep switchTerminal's deferred focus from blurring us
    nameEl.setAttribute('contenteditable', 'true');
    nameEl.spellcheck = false;
    nameEl.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(nameEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    const commit = save => {
      if (done) return;
      done = true;
      state._renamingTab = false;
      nameEl.removeAttribute('contenteditable');
      nameEl.removeEventListener('keydown', onKey);
      nameEl.removeEventListener('blur', onBlur);
      // Return focus to the active terminal so typing resumes immediately.
      try {
        const ai = termInstances.get(state.activeTermId);
        if (ai) ai.term.focus();
      } catch (_) {}
      const val = nameEl.textContent.replace(/\s+/g, ' ').trim();
      if (save && val) {
        nameEl.textContent = val;
        const inst = termInstances.get(termId);
        if (inst) inst.label = val;
        // Persist the rename so it survives an app restart.
        if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
          type: 'rename-term',
          termId,
          label: val
        }));
      } else {
        nameEl.textContent = prev;
      }
    };
    const onKey = ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        commit(false);
      }
    };
    const onBlur = () => commit(true);
    nameEl.addEventListener('keydown', onKey);
    nameEl.addEventListener('blur', onBlur);
  });
}
function getActiveTerm() {
  const inst = termInstances.get(state.activeTermId);
  return inst ? inst.term : null;
}

// Backward compat aliases
function get_term() {
  return termInstances.get('main')?.term;
}
Object.defineProperty(window, 'term', {
  get: () => get_term()
});
Object.defineProperty(window, 'fitAddon', {
  get: () => termInstances.get('main')?.fitAddon
});

// Create main terminal
createTermInstance('main', 'Shell 1');
enableTabRename(document.getElementById('mainTermTab'), 'main');

// ── Resize handling ─────────────────────────────────────────────────────
function fitTerminalNow() {
  const inst = termInstances.get(state.activeTermId);
  if (!inst) return;
  const el = inst.container;
  if (!el.offsetWidth || !el.offsetHeight) return;
  try {
    const dims = inst.fitAddon.proposeDimensions();
    if (!dims || dims.cols <= 0 || dims.rows <= 0) return;
    inst.fitAddon.fit();
    if (inst.term.cols !== state.lastCols || inst.term.rows !== state.lastRows) {
      state.lastCols = inst.term.cols;
      state.lastRows = inst.term.rows;
      if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
        type: 'resize',
        termId: state.activeTermId,
        cols: state.lastCols,
        rows: state.lastRows
      }));
    }
  } catch (_) {}
}
const resizeObs = new ResizeObserver(() => {
  if (state.fitDebounce) clearTimeout(state.fitDebounce);
  const inst = termInstances.get(state.activeTermId);
  if (inst) try {
    inst.fitAddon.fit();
  } catch (_) {}
  state.fitDebounce = setTimeout(() => {
    if (!inst) return;
    if (inst.term.cols !== state.lastCols || inst.term.rows !== state.lastRows) {
      state.lastCols = inst.term.cols;
      state.lastRows = inst.term.rows;
      if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
        type: 'resize',
        termId: state.activeTermId,
        cols: state.lastCols,
        rows: state.lastRows
      }));
    }
  }, 500);
});
resizeObs.observe(document.getElementById('termContainers'));
requestAnimationFrame(fitTerminalNow);

// ── WebSocket ─────────────────────────────────────────────────────────
function connect() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.ws = new WebSocket(`ws://${location.host}`);
  state.ws.onopen = () => {
    document.getElementById('statusDot').className = 'status-dot connected';
    document.getElementById('connectionStatus').textContent = 'Connected';
    const mainInst = termInstances.get('main');
    if (mainInst) {
      try {
        mainInst.fitAddon.fit();
      } catch (_) {}
      state.lastCols = mainInst.term.cols;
      state.lastRows = mainInst.term.rows;
      state.ws.send(JSON.stringify({
        type: 'resize',
        termId: 'main',
        cols: state.lastCols,
        rows: state.lastRows
      }));
    }
  };
  state.ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'output':
        {
          const tid = msg.termId || 'main';
          const inst = termInstances.get(tid);
          if (inst) {
            // Auto-scroll if user is near the bottom (within 5 lines)
            const wasNearBottom = inst.term.buffer.active.baseY - inst.term.buffer.active.viewportY <= 5;
            inst.term.write(msg.data);
            if (wasNearBottom) inst.term.scrollToBottom();
          }
          break;
        }
      case 'term-started':
        if (msg.termId && msg.cwd && termInstances.has(msg.termId)) {
          termInstances.get(msg.termId).cwd = msg.cwd;
        }
        document.getElementById('statusDot').className = 'status-dot connected';
        document.getElementById('connectionStatus').textContent = 'Connected';
        syncAiControls();
        if (state._shellReadyResolve) {
          const cb = state._shellReadyResolve;
          state._shellReadyResolve = null;
          setTimeout(cb, 300); // small delay to let PTY fully init
        }
        break;
      case 'term-list':
        {
          const list = Array.isArray(msg.terminals) ? msg.terminals : [];
          // Apply a persisted custom name to the main shell.
          if (msg.mainLabel) {
            const mainName = document.querySelector('#mainTermTab .term-tab-name');
            if (mainName) mainName.textContent = msg.mainLabel;
            const mi = termInstances.get('main');
            if (mi) mi.label = msg.mainLabel;
          }
          // Recreate any non-main shells that exist server-side but not in this
          // renderer. After an app restart the renderer is fresh, so this brings
          // back the user's open shells with their saved names + working dirs.
          // (On a ws reconnect the instances already exist, so this no-ops.)
          for (const t of list) {
            const id = typeof t === 'string' ? t : t && t.id;
            if (!id || id === 'main' || termInstances.has(id)) continue;
            const label = t && typeof t === 'object' && t.label ? t.label : id;
            createTermInstance(id, label);
            const inst = termInstances.get(id);
            if (inst && t && t.cwd) inst.cwd = t.cwd;
            const mm = /^term-(\d+)$/.exec(id);
            if (mm) state.termCounter = Math.max(state.termCounter, parseInt(mm[1], 10));
          }
          break;
        }
      case 'term-cwd':
        {
          const tid = msg.termId || 'main';
          const inst = termInstances.get(tid);
          if (inst) inst.cwd = msg.cwd || inst.cwd || '';
          // INTENTIONALLY do NOT auto-switch activeRepo when the terminal
          // cwd lands in a known repo. The user picks the repo from the
          // sidebar; cd-ing inside the terminal must not hijack that
          // selection. Symphonee's tools (scripts/, Mind, intelligence)
          // assume the terminal stays at Symphonee's own path.
          break;
        }
      case 'term-spawned':
        {
          // Orchestrator spawned a visible terminal - create tab for it
          const tid = msg.termId;
          if (!termInstances.has(tid)) {
            createTermInstance(tid, msg.label || msg.cli);
            const st = getTermAi(tid);
            st.cli = msg.cli;
            st.launched = true;
            st.orchestrated = true;
            st.taskId = msg.taskId;
            switchTerminal(tid);
            // Add orchestrated indicator dot to the tab
            const tabEl = document.querySelector(`.term-tab[data-term="${tid}"]`);
            if (tabEl) {
              const dot = document.createElement('span');
              dot.className = 'orch-dot';
              dot.title = 'Orchestrator task ' + msg.taskId;
              const closeBtn = tabEl.querySelector('.term-tab-close');
              tabEl.insertBefore(dot, closeBtn);
            }
            if (typeof orchRefreshAgents === 'function') orchRefreshAgents();
          }
          break;
        }
      case 'term-exited':
        {
          // Terminal process exited on its own (not from user clicking X)
          const tid = msg.termId;
          if (tid !== 'main' && termInstances.has(tid)) {
            const st = termAiState.get(tid);
            if (st && st.orchestrated) {
              // Keep orchestrated tabs open so user can see the output
              st.launched = false;
              st.orchestrated = false;
              const dot = document.querySelector(`.term-tab[data-term="${tid}"] .orch-dot`);
              if (dot) dot.remove();
            } else {
              closeTerminal(tid);
            }
          }
          // Refresh orchestrator agent list since a terminal is gone
          if (typeof orchRefreshAgents === 'function') orchRefreshAgents();
          break;
        }
      case 'config-changed':
        loadConfig();
        try {
          loadRepoList();
        } catch (_) {}
        try {
          applyPluginSpaceFilter();
        } catch (_) {}
        notifyPluginIframes('configChanged', {});
        break;
      case 'mind-startup-refresh':
        {
          // Auto-refresh fired on server boot. During the initial boot the
          // loading overlay covers this work, so we suppress the toast (the user
          // should not see "Mind refreshed" pop in right after reveal). It only
          // shows if the overlay already revealed -- the rare build that ran past
          // the overlay's wait cap.
          const p = msg.payload || {};
          if (p.phase === 'done' && state._bootOverlayDone && typeof toast === 'function') {
            const sec = p.durationMs ? Math.max(1, Math.round(p.durationMs / 1000)) : 0;
            const stat = p.stats ? ` ${p.stats.nodes} nodes` : '';
            toast(`Mind refreshed.${stat}${sec ? ' (' + sec + 's)' : ''}`, 'success', {
              duration: 3500,
              silent: true
            });
          } else if (p.phase === 'error' && typeof toast === 'function') {
            toast('Mind refresh failed: ' + (p.error || 'unknown'), 'error', {
              duration: 4500
            });
          }
          break;
        }
      case 'mind-update':
        {
          // Re-dispatch as a DOM event so feature-specific listeners (Smart
          // Search setup progress, mind-ui graph refresh, etc.) can hook
          // in without each having their own WebSocket.
          try {
            window.dispatchEvent(new CustomEvent('symphonee-mind-update', {
              detail: msg.payload || {}
            }));
          } catch (_) {}
          break;
        }
      case 'symphonee-intent':
        {
          // Brain intent updated. Re-dispatch as a DOM event so any future
          // listener can subscribe. No header UI consumes this today.
          try {
            window.dispatchEvent(new CustomEvent('symphonee-intent', {
              detail: msg.payload || {}
            }));
          } catch (_) {}
          break;
        }
      case 'symphonee-plan':
        {
          // A planner decision was logged. Re-dispatch for any listener
          // (decisions panel could subscribe).
          try {
            window.dispatchEvent(new CustomEvent('symphonee-plan', {
              detail: msg.payload || {}
            }));
          } catch (_) {}
          break;
        }
      case 'ui-action':
        handleUiAction(msg);
        break;
      case 'cache-updated':
        handleCacheUpdated(msg.cache, msg.data, msg.key);
        break;
      case 'git-changed':
        handleGitChanged(msg.repo, msg.branch);
        break;
      case 'orchestrator-event':
        handleOrchestratorEvent(msg);
        break;
      case 'ui-mutate':
        handleUiMutate(msg.ops || []);
        break;
      case 'notification':
        if (typeof notify === 'function') {
          notify(msg.title || 'Notification', msg.body || '', {
            icon: msg.icon || 'bell',
            source: msg.source || null,
            severity: msg.level || msg.severity || 'info'
          });
        }
        if (typeof toast === 'function') {
          toast(msg.title || 'Notification', msg.level || msg.severity || 'info', {
            duration: 5000
          });
        }
        break;
      case 'app-state-set':
        if (typeof _onAppStateSet === 'function') _onAppStateSet(msg.key, msg.value);
        break;
      case 'browser-agent-step':
        if (typeof handleBrowserAgentStep === 'function') handleBrowserAgentStep(msg);
        break;
      case 'stagehand-screencast':
        if (typeof handleStagehandScreencast === 'function') handleStagehandScreencast(msg);
        break;
      case 'browser-router-dispatch':
        if (typeof handleBrowserRouterDispatch === 'function') handleBrowserRouterDispatch(msg);
        break;
      case 'apps-agent-step':
        if (typeof handleAppsAgentStep === 'function') handleAppsAgentStep(msg);
        break;
      case 'apps-recording-ended':
        // PS recorder closed on its own (Ctrl+Shift+Q hotkey or target window
        // closed). Auto-finalize so the UI doesn't sit on a stale "Stop
        // recording" state.
        if (typeof appsAutomationsStopRecording === 'function' && state._appsRecording) {
          appsAutomationsStopRecording();
        }
        break;
      case 'action':
        if (typeof ledgerOnAction === 'function') ledgerOnAction(msg.entry);
        break;
      case 'action-patch':
        if (typeof ledgerOnActionPatch === 'function') ledgerOnActionPatch(msg.id, msg.fields);
        break;
    }
  };
  state.ws.onclose = () => {
    document.getElementById('statusDot').className = 'status-dot error';
    document.getElementById('connectionStatus').textContent = 'Disconnected';
    state.reconnectTimer = setTimeout(connect, 2500);
  };
}// ── Focus / context-awareness state push ────────────────────────────────
// Thin wrapper that POSTs the latest user focus to the server. The server
// keeps it so any AI worker can call GET /api/application-state/focus and
// know what the user is currently looking at without needing to ask.
state._pushFocusTimer = null;
state._pendingFocus = {};
function _pushFocus(patch) {
  Object.assign(state._pendingFocus, patch || {});
  clearTimeout(state._pushFocusTimer);
  state._pushFocusTimer = setTimeout(() => {
    const body = state._pendingFocus;
    state._pendingFocus = {};
    fetch('/api/application-state/focus', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }).catch(() => {});
  }, 250);
  // Also mirror into the 'navigation' application-state key so AI agents get
  // the agent-native shape (view, repo, selection) without extra endpoints.
  _pushNavigation({
    view: patch.activeTab,
    repo: patch.activeRepo,
    selection: patch.selection,
    updatedAt: Date.now()
  });
}

// ── Application state (agent-native pattern) ───────────────────────────
// The UI writes a 'navigation' snapshot so the AI knows what you're looking
// at. The AI writes 'navigate' commands which we act on and delete.
state._pushNavTimer = null;
state._pendingNav = null;
function _pushNavigation(patch) {
  state._pendingNav = Object.assign(state._pendingNav || {}, patch || {});
  clearTimeout(state._pushNavTimer);
  state._pushNavTimer = setTimeout(() => {
    const body = {
      value: state._pendingNav
    };
    state._pendingNav = null;
    fetch('/api/application-state/navigation', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }).catch(() => {});
  }, 200);
}
// Central dispatcher for 'app-state-set' WS events.
function _onAppStateSet(key, value) {
  if (key === 'navigate' && value) _handleNavigateCommand(value);
}
function _handleNavigateCommand(cmd) {
  try {
    // Possible fields: view (tab id), repo (repo name), path (URL-style).
    if (cmd.view && typeof switchTab === 'function') switchTab(cmd.view);
    if (cmd.repo && typeof selectRepo === 'function') {
      selectRepo(cmd.repo);
    }
    if (cmd.path && typeof cmd.path === 'string') {
      // Reserved for future router wiring; log for now.
      console.log('[app-state] navigate to path:', cmd.path);
    }
    notify('Agent navigated', 'View: ' + (cmd.view || cmd.path || cmd.repo || 'unknown'), {
      icon: 'navigation'
    });
  } catch (e) {
    console.warn('[app-state] navigate failed', e);
  }
  // One-shot: clear the command so it doesn't fire twice.
  fetch('/api/application-state/navigate', {
    method: 'DELETE'
  }).catch(() => {});
}
// On boot, check if there's a pending 'navigate' command we missed before
// the WS connected.
(async () => {
  try {
    const r = await fetch('/api/application-state/navigate');
    if (!r.ok) return;
    const j = await r.json();
    if (j && j.value) _handleNavigateCommand(j.value);
  } catch (_) {}
})();

// Capture non-trivial text selections anywhere in the app. Debounced so we
// don't ship a POST per character drag.
state._selTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(state._selTimer);
  state._selTimer = setTimeout(() => {
    try {
      const sel = String(window.getSelection ? window.getSelection().toString() : '').trim();
      if (sel.length >= 3) _pushFocus({
        selection: sel.slice(0, 2000)
      });
    } catch (_) {}
  }, 400);
});

// ── Scheduled / recurring AI jobs ───────────────────────────────────────
// Thin UI over /api/jobs. A job is a saved prompt + CLI + schedule that the
// server fires automatically. Shape exactly mirrors jobs-scheduler.js.

async function _fetchJobs() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) return [];
    return await res.json();
  } catch (_) {
    return [];
  }
}
function _fmtWhen(ms) {
  if (!ms) return 'never';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  }) : d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
async function openJobsModal() {
  let overlay = document.getElementById('jobsOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'jobsOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3200;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove();
  };
  const jobs = await _fetchJobs();
  const rows = jobs.length ? jobs.map(j => {
    const cliLabel = CLI_CONFIG[j.cli] && CLI_CONFIG[j.cli].label || j.cli;
    return '<div class="job-row">' + '<div class="job-main">' + '<div class="job-name">' + esc(j.name) + (j.enabled ? '' : ' <span class="job-flag">paused</span>') + '</div>' + '<div class="job-meta">' + esc(cliLabel) + ' - ' + esc(j.schedule) + ' - next ' + _fmtWhen(j.nextRun) + '</div>' + '</div>' + '<div class="job-actions">' + '<button class="sy-btn sy-btn-sm sy-btn-secondary" onclick="runJobNow(\'' + j.id + '\')">Run</button>' + '<button class="sy-btn sy-btn-sm sy-btn-outline" onclick="openJobEditor(\'' + j.id + '\')">Edit</button>' + '<button class="sy-btn sy-btn-sm sy-btn-ghost" onclick="deleteJob(\'' + j.id + '\')" style="color:var(--red);">Delete</button>' + '</div>' + '</div>';
  }).join('') : '<div style="padding:26px 12px;text-align:center;color:var(--subtext0);font-size:12px;">No scheduled jobs yet. Create one to run an AI prompt on a recurring schedule.</div>';
  overlay.innerHTML = '<div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:10px;width:640px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.5);">' + '<div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--surface2);">' + '<i data-lucide="calendar-clock" style="width:18px;height:18px;color:var(--accent);"></i>' + '<strong style="font-size:14px;">Scheduled Jobs</strong>' + '<div style="flex:1;"></div>' + '<button onclick="openJobEditor()" class="sy-btn sy-btn-sm"><i data-lucide="plus"></i>New Job</button>' + '<button onclick="document.getElementById(\'jobsOverlay\').remove()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>' + '</div>' + '<div style="overflow-y:auto;padding:8px 10px;">' + rows + '</div>' + '</div>';
  document.body.appendChild(overlay);
  try {
    lucide.createIcons({
      nodes: [overlay]
    });
  } catch (_) {}
}
async function openJobEditor(id) {
  const jobs = await _fetchJobs();
  const existing = id ? jobs.find(j => j.id === id) : null;
  let overlay = document.getElementById('jobEditorOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'jobEditorOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3300;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove();
  };
  const cliOpts = Object.keys(CLI_CONFIG).map(k => '<option value="' + k + '"' + ((existing ? existing.cli : 'claude') === k ? ' selected' : '') + '>' + esc(CLI_CONFIG[k].label) + '</option>').join('');
  overlay.innerHTML = '<div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:10px;width:520px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);padding:16px 20px;">' + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">' + '<i data-lucide="' + (existing ? 'pencil' : 'plus') + '" style="width:17px;height:17px;color:var(--accent);"></i>' + '<strong style="font-size:14px;">' + (existing ? 'Edit job' : 'New scheduled job') + '</strong>' + '</div>' + '<div style="display:grid;grid-template-columns:1fr;gap:10px;">' + '<label style="font-size:11px;color:var(--subtext0);">Name<input id="jobName" type="text" value="' + esc(existing ? existing.name : '') + '" placeholder="Morning digest" style="width:100%;margin-top:4px;padding:7px 10px;background:var(--crust);border:1px solid var(--surface2);border-radius:6px;color:var(--text);font:13px var(--font-ui);outline:none;"></label>' + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' + '<label style="font-size:11px;color:var(--subtext0);">Runner<select id="jobCli" style="width:100%;margin-top:4px;padding:7px 10px;background:var(--crust);border:1px solid var(--surface2);border-radius:6px;color:var(--text);font:13px var(--font-ui);outline:none;">' + cliOpts + '</select></label>' + '<label style="font-size:11px;color:var(--subtext0);">Schedule<input id="jobSchedule" type="text" value="' + esc(existing ? existing.schedule : 'daily 09:00') + '" placeholder="daily 09:00" style="width:100%;margin-top:4px;padding:7px 10px;background:var(--crust);border:1px solid var(--surface2);border-radius:6px;color:var(--text);font:13px var(--font-mono);outline:none;"></label>' + '</div>' + '<div style="font-size:10px;color:var(--overlay1);line-height:1.5;">Formats: <code>daily HH:MM</code>, <code>hourly :MM</code>, <code>weekly DOW HH:MM</code> (DOW 0=Sun), <code>every Nm</code>, <code>every Nh</code></div>' + '<label style="font-size:11px;color:var(--subtext0);">Prompt<textarea id="jobPrompt" placeholder="Summarize my notes from the past 7 days and list any open action items." style="width:100%;margin-top:4px;padding:10px;background:var(--crust);border:1px solid var(--surface2);border-radius:6px;color:var(--text);font:13px var(--font-ui);outline:none;min-height:120px;resize:vertical;">' + esc(existing ? existing.prompt : '') + '</textarea></label>' + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--subtext1);"><input id="jobEnabled" type="checkbox"' + (existing && existing.enabled === false ? '' : ' checked') + '> Enabled</label>' + '</div>' + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' + '<button onclick="document.getElementById(\'jobEditorOverlay\').remove()" class="sy-btn sy-btn-ghost">Cancel</button>' + '<button onclick="saveJobFromEditor(' + (existing ? '\'' + existing.id + '\'' : 'null') + ')" class="sy-btn">Save</button>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  try {
    lucide.createIcons({
      nodes: [overlay]
    });
  } catch (_) {}
  setTimeout(() => {
    document.getElementById('jobName')?.focus();
  }, 60);
}
async function saveJobFromEditor(id) {
  const body = {
    id: id || undefined,
    name: (document.getElementById('jobName')?.value || '').trim(),
    cli: document.getElementById('jobCli')?.value || 'claude',
    schedule: (document.getElementById('jobSchedule')?.value || '').trim(),
    prompt: (document.getElementById('jobPrompt')?.value || '').trim(),
    enabled: !!document.getElementById('jobEnabled')?.checked
  };
  if (!body.name) {
    toast('Name is required', 'warning');
    return;
  }
  if (!body.prompt) {
    toast('Prompt is required', 'warning');
    return;
  }
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'HTTP ' + res.status);
    }
    document.getElementById('jobEditorOverlay')?.remove();
    toast(id ? 'Job updated' : 'Job scheduled', 'success');
    if (document.getElementById('jobsOverlay')) openJobsModal();
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}
async function runJobNow(id) {
  try {
    const res = await fetch('/api/jobs/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast('Job dispatched', 'success', {
      action: {
        label: 'View',
        onClick: () => {
          document.getElementById('jobsOverlay')?.remove();
          switchTab('orchestrator');
        }
      }
    });
    try {
      orchRefreshTasks();
    } catch (_) {}
  } catch (e) {
    toast('Run failed: ' + e.message, 'error');
  }
}
async function deleteJob(id) {
  const ok = await (typeof confirmDialog === 'function' ? confirmDialog('Delete this scheduled job?', {
    confirmText: 'Delete',
    danger: true
  }) : Promise.resolve(confirm('Delete this scheduled job?')));
  if (!ok) return;
  try {
    await fetch('/api/jobs', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id
      })
    });
    toast('Job deleted', 'info');
    if (document.getElementById('jobsOverlay')) openJobsModal();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}

// ── Onboarding checklist ────────────────────────────────────────────────
// Small dismissible chip in the header showing "N of M complete". Clicking
// it opens a popover with the full checklist. Completion is inferred from
// persistent signals (did the user launch an AI? open notes? open palette?)
// and persisted in localStorage so progress sticks across sessions.

const ONBOARDING_STEPS = [{
  id: 'palette',
  label: 'Open the command palette',
  hint: 'Press Ctrl+K',
  test: () => !!localStorage.getItem('symphonee-ob-palette')
}, {
  id: 'launch',
  label: 'Launch your first AI session',
  hint: 'Terminal tab',
  test: () => !!localStorage.getItem('symphonee-ob-launch')
}, {
  id: 'note',
  label: 'Create or open a note',
  hint: 'Notes tab',
  test: () => !!localStorage.getItem('symphonee-ob-note')
}, {
  id: 'shortcut',
  label: 'Try a sequence shortcut',
  hint: 'Press g then t',
  test: () => !!localStorage.getItem('symphonee-ob-shortcut')
}];
function markOnboarding(id) {
  try {
    localStorage.setItem('symphonee-ob-' + id, '1');
  } catch (_) {}
  renderOnboardingChip();
}
function renderOnboardingChip() {
  const chip = document.getElementById('onboardingChip');
  const text = document.getElementById('onboardingChipText');
  if (!chip || !text) return;
  const dismissed = localStorage.getItem('symphonee-ob-dismissed') === '1';
  const done = ONBOARDING_STEPS.filter(s => s.test()).length;
  const total = ONBOARDING_STEPS.length;
  if (dismissed || done === total) {
    chip.style.display = 'none';
    return;
  }
  chip.style.display = 'inline-flex';
  text.textContent = done + ' of ' + total;
}
function toggleOnboardingPanel(ev) {
  if (ev) ev.stopPropagation();
  let panel = document.getElementById('onboardingPanel');
  if (panel) {
    panel.remove();
    return;
  }
  panel = document.createElement('div');
  panel.id = 'onboardingPanel';
  panel.className = 'onboarding-panel';
  const doneCount = ONBOARDING_STEPS.filter(s => s.test()).length;
  const total = ONBOARDING_STEPS.length;
  const progressDots = ONBOARDING_STEPS.map((_, i) => '<div class="ob-progress-dot ' + (i < doneCount ? 'done' : '') + '"></div>').join('');
  const steps = ONBOARDING_STEPS.map((s, i) => {
    const done = s.test();
    return '<div class="ob-step' + (done ? ' done' : '') + '">' + '<i data-lucide="' + (done ? 'check-circle' : 'circle') + '" style="width:14px;height:14px;"></i>' + '<div class="ob-step-main"><div class="ob-step-label">' + esc(s.label) + '</div><div class="ob-step-hint">' + esc(s.hint) + '</div></div>' + '</div>';
  }).join('');
  const allDone = doneCount === total;
  panel.innerHTML = '<div class="ob-head">' + '<strong>Getting started ' + doneCount + '/' + total + '</strong>' + '<button onclick="dismissOnboarding()" class="ob-dismiss" title="Dismiss">Dismiss</button>' + '</div>' + '<div class="ob-progress">' + progressDots + '</div>' + (allDone ? '<div class="ob-all-done">All set. <strong>Nice work.</strong></div>' : '<div class="ob-steps">' + steps + '</div>');
  document.body.appendChild(panel);
  // Position below the chip.
  const chip = document.getElementById('onboardingChip');
  if (chip) {
    const r = chip.getBoundingClientRect();
    panel.style.top = r.bottom + 8 + 'px';
    panel.style.right = window.innerWidth - r.right + 'px';
  }
  try {
    lucide.createIcons({
      nodes: [panel]
    });
  } catch (_) {}
  const close = e => {
    if (!panel.contains(e.target) && e.target !== chip) {
      panel.remove();
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}
function dismissOnboarding() {
  localStorage.setItem('symphonee-ob-dismissed', '1');
  const p = document.getElementById('onboardingPanel');
  if (p) p.remove();
  renderOnboardingChip();
}

// Refresh chip on significant actions.
setInterval(renderOnboardingChip, 4000);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderOnboardingChip, {
    once: true
  });
} else {
  renderOnboardingChip();
}

// ── Runtime UI Mutations ────────────────────────────────────────────────
// The AI can POST to /api/ui/mutate to add tabs, FABs, or collapse panels
// LIVE while the user is inside Symphonee. Mutations persist to localStorage
// so they survive reloads without editing source files. Non-destructive: a
// "reset" op wipes them all; the Settings tab lists them for manual removal.

const UI_MUT_KEY = 'symphonee-ui-mutations-v1';
function _loadUiMutations() {
  try {
    return JSON.parse(localStorage.getItem(UI_MUT_KEY) || '[]');
  } catch (_) {
    return [];
  }
}
function _saveUiMutations(list) {
  try {
    localStorage.setItem(UI_MUT_KEY, JSON.stringify(list));
  } catch (_) {}
}
function _addUiMutation(op) {
  if (!op || op.op === 'reset') {
    _saveUiMutations([]);
    return;
  }
  const list = _loadUiMutations();
  // Merge strategy: if the op has an id, replace any prior op with the same id+type.
  const idx = op.id ? list.findIndex(x => x.id === op.id && x.op === op.op) : -1;
  if (idx >= 0) list[idx] = op;else list.push(op);
  _saveUiMutations(list);
}
function handleUiMutate(ops) {
  if (!Array.isArray(ops)) return;
  for (const op of ops) {
    try {
      applyUiMutation(op);
      _addUiMutation(op);
    } catch (e) {
      console.error('ui-mutate failed:', e);
      toast('UI mutation failed: ' + e.message, 'error');
    }
  }
  try {
    lucide.createIcons();
  } catch (_) {}
}
function applyUiMutation(op) {
  if (!op || typeof op !== 'object') return;
  switch (op.op) {
    case 'addTab':
      {
        if (!op.id || !op.label) throw new Error('addTab requires id and label');
        const safeId = String(op.id).replace(/[^a-zA-Z0-9_-]/g, '-');
        const bar = document.getElementById('tabBarScroll');
        if (bar && !document.querySelector('button.tab-btn[data-tab="' + safeId + '"][data-user-tab="1"]')) {
          const btn = document.createElement('button');
          btn.className = 'tab-btn';
          btn.dataset.tab = safeId;
          btn.dataset.userTab = '1';
          btn.onclick = () => switchTab(safeId);
          btn.innerHTML = esc(op.label) + ' <span style="opacity:0.5;font-size:13px;margin-left:6px;cursor:pointer;" onclick="event.stopPropagation();removeUserTab(\'' + safeId + '\')" title="Remove">x</span>';
          const _maxOrder = Math.max(0, ...[...bar.querySelectorAll('.tab-btn')].map(t => parseFloat(t.style.order) || 0));
          btn.style.order = String(_maxOrder + 1);
          bar.appendChild(btn);
        }
        const center = document.querySelector('.center');
        if (center && !document.getElementById('panel-' + safeId)) {
          const panel = document.createElement('div');
          panel.className = 'tab-panel';
          panel.id = 'panel-' + safeId;
          panel.dataset.userTab = '1';
          panel.style.padding = '16px 20px';
          panel.style.overflowY = 'auto';
          panel.innerHTML = op.bodyHtml ? String(op.bodyHtml) : '<div class="empty-state"><i data-lucide="layout"></i><div class="empty-state-text">' + esc(op.label) + '</div></div>';
          center.appendChild(panel);
        }
        return;
      }
    case 'removeTab':
      {
        if (!op.id) return;
        const safeId = String(op.id).replace(/[^a-zA-Z0-9_-]/g, '-');
        document.querySelectorAll('button.tab-btn[data-tab="' + safeId + '"][data-user-tab="1"]').forEach(b => b.remove());
        const p = document.getElementById('panel-' + safeId);
        if (p && p.dataset.userTab === '1') p.remove();
        return;
      }
    case 'setTabHidden':
      {
        const safeId = String(op.id || '').replace(/[^a-zA-Z0-9_-]/g, '-');
        const btn = document.querySelector('button.tab-btn[data-tab="' + safeId + '"]');
        if (btn) btn.style.display = op.hidden ? 'none' : '';
        return;
      }
    case 'addFab':
      {
        if (!op.id) throw new Error('addFab requires id');
        const safeId = String(op.id).replace(/[^a-zA-Z0-9_-]/g, '-');
        let host = document.getElementById('fabLayer');
        if (!host) {
          host = document.createElement('div');
          host.id = 'fabLayer';
          host.className = 'fab-layer';
          document.body.appendChild(host);
        }
        let btn = document.getElementById('fab-' + safeId);
        if (!btn) {
          btn = document.createElement('button');
          btn.id = 'fab-' + safeId;
          btn.className = 'fab';
          host.appendChild(btn);
        }
        const icon = (op.icon || 'sparkles').replace(/[^a-z0-9-]/gi, '');
        btn.innerHTML = '<i data-lucide="' + icon + '"></i><span class="fab-label">' + esc(op.label || 'Action') + '</span>';
        btn.onclick = () => {
          if (op.prompt) askAIFromPalette(String(op.prompt));else if (op.href) window.open(op.href, '_blank');else if (op.tab) switchTab(String(op.tab));
        };
        return;
      }
    case 'removeFab':
      {
        const safeId = String(op.id || '').replace(/[^a-zA-Z0-9_-]/g, '-');
        const b = document.getElementById('fab-' + safeId);
        if (b) b.remove();
        return;
      }
    case 'setCollapsed':
      {
        if (!op.target) return;
        try {
          document.querySelectorAll(String(op.target)).forEach(el => {
            if (op.collapsed) {
              el.dataset._prevDisplay = el.style.display || '';
              el.style.display = 'none';
            } else {
              el.style.display = el.dataset._prevDisplay || '';
              delete el.dataset._prevDisplay;
            }
          });
        } catch (_) {}
        return;
      }
    case 'reset':
      {
        // Remove all user-added tabs, FABs and unhide anything we hid.
        document.querySelectorAll('button.tab-btn[data-user-tab="1"]').forEach(b => b.remove());
        document.querySelectorAll('.tab-panel[data-user-tab="1"]').forEach(p => p.remove());
        const host = document.getElementById('fabLayer');
        if (host) host.innerHTML = '';
        return;
      }
    default:
      throw new Error('Unknown ui-mutate op: ' + op.op);
  }
}
function removeUserTab(id) {
  handleUiMutate([{
    op: 'removeTab',
    id
  }]);
  // If the removed tab was active, fall back to Terminal.
  const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
  if (!activeTab || activeTab === id) switchTab('terminal');
  toast('Tab removed', 'info');
}

// Replay persisted mutations on load so customizations survive refresh.
(function _replayUiMutations() {
  try {
    const run = () => {
      const list = _loadUiMutations();
      if (!list.length) return;
      for (const op of list) {
        try {
          applyUiMutation(op);
        } catch (e) {
          console.warn('replay mutation failed:', e);
        }
      }
      try {
        lucide.createIcons();
      } catch (_) {}
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, {
        once: true
      });
    } else {
      run();
    }
  } catch (_) {}
})();

// ── Background Task Pills System ────────────────────────────────────────
// Shows running operations as small pills at the bottom of the center panel.
// Inspired by Claude Code's polymorphic task system.

const _bgTasks = new Map(); // id -> { label, status, startTime, icon }
let _taskPillsTimer = null;
function addBackgroundTask(id, label, icon) {
  _bgTasks.set(id, {
    label,
    status: 'running',
    startTime: Date.now(),
    icon: icon || 'loader'
  });
  return id;
}
function completeBackgroundTask(id, success) {
  const task = _bgTasks.get(id);
  if (task) {
    task.status = success !== false ? 'done' : 'error';
    task.endTime = Date.now();
    _bgTasks.delete(id);
  }
}
function renderTaskPills() {
  const container = document.getElementById('taskPillsBar');
  if (!container) return;
  if (_bgTasks.size === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = [..._bgTasks.entries()].map(([id, t]) => {
    const elapsed = ((t.endTime || Date.now()) - t.startTime) / 1000;
    const elapsedStr = elapsed < 60 ? Math.round(elapsed) + 's' : Math.round(elapsed / 60) + 'm';
    const iconName = t.icon || (t.status === 'done' ? 'check' : t.status === 'warning' ? 'alert-triangle' : t.status === 'info' ? 'info' : 'x');
    const statusIcon = t.status === 'running' ? '<div class="task-pill-spinner"></div>' : `<i data-lucide="${iconName}" class="task-pill-icon"></i>`;
    return `<div class="task-pill ${t.status}" data-id="${id}">${statusIcon} ${esc(t.label)} <span class="task-pill-elapsed">${elapsedStr}</span></div>`;
  }).join('');
  try {
    lucide.createIcons({
      nodes: [container]
    });
  } catch (_) {}
}

// Update running task elapsed times
setInterval(() => {
  if (_bgTasks.size > 0 && [..._bgTasks.values()].some(t => t.status === 'running')) {
    renderTaskPills();
  }
}, 1000);

// ── Background cache refresh ─────────────────────────────────────────────
function handleCacheUpdated(cacheName, data, key) {
  if (cacheName === 'workitems') {
    // Only apply if the broadcast key matches the active query
    if (key && state._activeWiCacheKey && key !== state._activeWiCacheKey) return;
    if (Array.isArray(data)) {
      state.workItems = data;
    } else if (data && data.items) {
      state.workItems = data.items;
      state.hasMoreClosed = data.hasMoreClosed || false;
      state.totalClosedCount = data.totalClosed || 0;
      state.totalClosedCapped = data.totalClosedCapped || false;
    }
    renderBoard();
    renderBacklog();
  }
}
function handleGitChanged(repoName, branch) {
  const gitModal = document.getElementById('gitModal');
  if (gitModal && gitModal.style.display !== 'none') {
    loadGitBranches();
  }
  const branchLabel = document.getElementById('gitCurrentBranch');
  if (branchLabel && branch) branchLabel.textContent = branch;
  // Keep the header branch chip in sync whenever the active repo's branch moves.
  if (repoName && repoName === state.activeRepo) {
    if (branch) _setBranchChip(branch);else refreshBranchChip();
  }
}

// ── Header branch chip ────────────────────────────────────────────────────
function _setBranchChip(branchName) {
  const chip = document.getElementById('branchChip');
  const sep = document.getElementById('branchChipSep');
  const label = document.getElementById('branchChipLabel');
  if (!chip || !label) return;
  // Show the chip whenever a repo is active; branch name may still be loading.
  const show = !!state.activeRepo;
  chip.style.display = show ? '' : 'none';
  if (sep) sep.style.display = show ? '' : 'none';
  label.textContent = branchName || (state.activeRepo ? '...' : '');
  chip.title = branchName ? 'Branch: ' + branchName + ' (click to switch)' : 'Switch branch';
}
async function refreshBranchChip() {
  const chip = document.getElementById('branchChip');
  if (!chip) return;
  if (!state.activeRepo) {
    _setBranchChip('');
    return;
  }
  _setBranchChip(''); // show chip immediately with "..." label
  try {
    const r = await fetch('/api/git/branches?repo=' + encodeURIComponent(state.activeRepo));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    _setBranchChip(data && data.current ? data.current : '');
  } catch (_) {
    _setBranchChip(''); // keep chip visible, label stays as "..."
  }
}
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(refreshBranchChip, 300);
});// ── File Browser ────────────────────────────────────────────────────────
state.filesCurrentRepo = '';
state.filesCurrentPath = '';
state.filesCurrentFile = null;
state.filesMode = 'view'; // view, diff, edit
function populateFilesRepoSelect() {
  const select = document.getElementById('filesRepoSelect');
  const repos = state.configData.Repos || {};
  const repoNames = _repoNamesForSpace(repos, window._spacesCache || {}, state.activeSpace);
  select.innerHTML = '<option value="">Select repo...</option>';
  for (const name of repoNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === state.filesCurrentRepo) opt.selected = true;
    select.appendChild(opt);
  }
}
function refreshFilesSearchIfActive() {
  const searchInput = document.getElementById('filesSearchInput');
  if (searchInput && searchInput.value.trim()) onFilesSearchInput();
}
async function loadFileTree(subPath) {
  // Sync from dropdown if no activeRepo set
  const select = document.getElementById('filesRepoSelect');
  if (!state.filesCurrentRepo && select) state.filesCurrentRepo = select.value;
  if (subPath !== undefined) state.filesCurrentPath = subPath;
  if (!state.filesCurrentRepo) {
    document.getElementById('filesTree').innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">Select a repository</div></div>';
    document.getElementById('filesGitBar').style.display = 'none';
    document.getElementById('filesBreadcrumb').innerHTML = '';
    refreshFilesSearchIfActive();
    return;
  }

  // Load git info into header
  try {
    const gitRes = await fetch(`/api/git/status?repo=${encodeURIComponent(state.filesCurrentRepo)}`);
    const git = await gitRes.json();
    if (!git.error) {
      document.getElementById('filesGitBar').style.display = '';
      document.getElementById('filesBranch').textContent = git.branch;
      const statusEl = document.getElementById('filesGitStatus');
      statusEl.textContent = git.clean ? 'clean' : `${git.files.length} changed`;
      statusEl.className = `files-git-status ${git.clean ? 'clean' : 'dirty'}`;

      // Show changed files list
      const changedBar = document.getElementById('filesChangedBar');
      const changedList = document.getElementById('filesChangedList');
      if (git.files && git.files.length > 0) {
        changedBar.style.display = '';
        changedList.innerHTML = git.files.map(f => `
          <div class="changed-file" onclick="viewChangedFile('${esc(f.file)}')" oncontextmenu="event.preventDefault();showDiffFileContextMenu(event,'${esc(f.file).replace(/'/g, "\\'")}')" title="${esc(f.file)}">
            <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.file)}</span>
          </div>
        `).join('');
        // Auto-show the Diff tab and populate it with changed files
        document.getElementById('diffviewTabBtn').style.display = '';
        populateDiffTabWithChanges(git.files, state.filesCurrentRepo);
      } else {
        changedBar.style.display = 'none';
        // Hide diff tab if no changes and no commit diff
        if (!state.diffViewCommit) document.getElementById('diffviewTabBtn').style.display = 'none';
      }
    }
  } catch (_) {}

  // Breadcrumb
  renderFilesBreadcrumb();

  // Load tree
  try {
    const res = await fetch(`/api/files/tree?repo=${encodeURIComponent(state.filesCurrentRepo)}&path=${encodeURIComponent(state.filesCurrentPath)}`);
    const data = await res.json();
    if (data.error) {
      document.getElementById('filesTree').innerHTML = `<div class="empty-state" style="padding:20px;"><div class="empty-state-text">${esc(data.error)}</div></div>`;
      refreshFilesSearchIfActive();
      return;
    }
    const tree = document.getElementById('filesTree');
    if (data.entries.length === 0) {
      tree.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);text-align:center;">Empty directory</div>';
      refreshFilesSearchIfActive();
      return;
    }
    tree.innerHTML = data.entries.map(e => `
      <div class="file-item ${e.isDir ? 'dir' : ''} ${state.filesCurrentFile && state.filesCurrentFile.path === e.path ? 'active' : ''}"
           onclick="${e.isDir ? `loadFileTree('${esc(e.path)}')` : `viewFile('${esc(e.path)}')`}"
           oncontextmenu="event.preventDefault();showFileTreeContextMenu(event,'${esc(e.path)}')">
        <i data-lucide="${e.isDir ? 'folder' : fileIcon(e.name)}"></i>
        <span>${esc(e.name)}</span>
      </div>
    `).join('');
    try {
      lucide.createIcons();
    } catch (_) {}
  } catch (e) {
    document.getElementById('filesTree').innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">Failed to load</div></div>';
  }
  refreshFilesSearchIfActive();
}
function renderFilesBreadcrumb() {
  const bc = document.getElementById('filesBreadcrumb');
  if (!state.filesCurrentPath) {
    bc.innerHTML = `<span style="color:var(--text);font-weight:600;">${esc(state.filesCurrentRepo)}</span>`;
    return;
  }
  const parts = state.filesCurrentPath.split('/');
  let html = `<button class="files-breadcrumb-link" onclick="loadFileTree('')">${esc(state.filesCurrentRepo)}</button>`;
  let cumulative = '';
  for (let i = 0; i < parts.length; i++) {
    cumulative += (cumulative ? '/' : '') + parts[i];
    html += `<span class="files-breadcrumb-sep">/</span>`;
    if (i < parts.length - 1) {
      html += `<button class="files-breadcrumb-link" onclick="loadFileTree('${esc(cumulative)}')">${esc(parts[i])}</button>`;
    } else {
      html += `<span style="color:var(--text)">${esc(parts[i])}</span>`;
    }
  }
  bc.innerHTML = html;
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    js: 'file-code',
    ts: 'file-code',
    jsx: 'file-code',
    tsx: 'file-code',
    py: 'file-code',
    cs: 'file-code',
    css: 'file-code',
    html: 'file-code',
    json: 'file-json',
    md: 'file-text',
    txt: 'file-text',
    png: 'image',
    jpg: 'image',
    svg: 'image',
    gif: 'image'
  };
  return icons[ext] || 'file';
}

// ── Files Search ──────────────────────────────────────────────────────
state._filesSearchMode = 'file'; // 'file' or 'content'
state._filesSearchTimer = null;
function setFilesSearchMode(mode) {
  state._filesSearchMode = mode;
  document.getElementById('filesSearchModeFile').classList.toggle('active', mode === 'file');
  document.getElementById('filesSearchModeContent').classList.toggle('active', mode === 'content');
  document.getElementById('filesSearchInput').placeholder = mode === 'file' ? 'Search files...' : 'Search in files...';
  const q = document.getElementById('filesSearchInput').value.trim();
  if (q) onFilesSearchInput();
}
function onFilesSearchInput() {
  clearTimeout(state._filesSearchTimer);
  const q = document.getElementById('filesSearchInput').value.trim();
  const resultsEl = document.getElementById('filesSearchResults');
  const treeEl = document.getElementById('filesTree');
  const bcEl = document.getElementById('filesBreadcrumb');
  const changedBar = document.getElementById('filesChangedBar');
  const gitBar = document.getElementById('filesGitBar');
  const scriptsBar = document.getElementById('filesScriptsBar');
  if (!q) {
    resultsEl.style.display = 'none';
    resultsEl.innerHTML = '';
    treeEl.style.display = '';
    bcEl.style.display = '';
    // Restore bars only if they were populated
    if (gitBar && gitBar.dataset.wasVisible) gitBar.style.display = '';
    if (changedBar && changedBar.dataset.wasVisible) changedBar.style.display = '';
    if (scriptsBar && scriptsBar.dataset.wasVisible) scriptsBar.style.display = '';
    return;
  }

  // Remember which bars were visible before hiding
  if (gitBar && gitBar.style.display !== 'none') gitBar.dataset.wasVisible = '1';
  if (changedBar && changedBar.style.display !== 'none') changedBar.dataset.wasVisible = '1';
  if (scriptsBar && scriptsBar.style.display !== 'none') scriptsBar.dataset.wasVisible = '1';

  // Hide tree and bars, show results
  treeEl.style.display = 'none';
  bcEl.style.display = 'none';
  if (gitBar) gitBar.style.display = 'none';
  if (changedBar) changedBar.style.display = 'none';
  if (scriptsBar) scriptsBar.style.display = 'none';
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div style="padding:12px;text-align:center;"><div class="spinner" style="margin:0 auto;"></div></div>';
  const delay = state._filesSearchMode === 'content' ? 400 : 250;
  state._filesSearchTimer = setTimeout(() => runFilesSearch(q), delay);
}
async function runFilesSearch(query) {
  const resultsEl = document.getElementById('filesSearchResults');
  if (!state.filesCurrentRepo) {
    resultsEl.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);text-align:center;">Select a repository first</div>';
    return;
  }
  const endpoint = state._filesSearchMode === 'file' ? '/api/files/search' : '/api/files/grep';
  const scopePath = state.filesCurrentPath || '';
  try {
    const res = await fetch(`${endpoint}?repo=${encodeURIComponent(state.filesCurrentRepo)}&path=${encodeURIComponent(scopePath)}&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data.error) {
      resultsEl.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--red);">${esc(data.error)}</div>`;
      return;
    }
    if (data.results.length === 0) {
      resultsEl.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);text-align:center;">No results found</div>';
      return;
    }
    if (state._filesSearchMode === 'file') {
      resultsEl.innerHTML = data.results.map(r => {
        const dir = r.path.includes('/') ? r.path.substring(0, r.path.lastIndexOf('/')) : '';
        return `<div class="search-result" onclick="viewFile('${esc(r.path)}', 1)">
          <i data-lucide="file" class="search-result-icon" style="width:14px;height:14px;"></i>
          <div style="overflow:hidden;">
            <div class="search-result-name">${esc(r.name)}</div>
            ${dir ? `<div class="search-result-path">${esc(dir)}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    } else {
      // Group by file
      const grouped = new Map();
      for (const r of data.results) {
        if (!grouped.has(r.path)) grouped.set(r.path, []);
        grouped.get(r.path).push(r);
      }
      const qLower = query.toLowerCase();
      const qEscaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      let html = '';
      for (const [filePath, matches] of grouped) {
        const name = filePath.includes('/') ? filePath.substring(filePath.lastIndexOf('/') + 1) : filePath;
        html += `<div style="padding:4px 10px;font-size:10px;font-weight:600;color:var(--overlay1);background:var(--surface0);border-bottom:1px solid var(--surface0);display:flex;align-items:center;gap:4px;cursor:pointer;" onclick="viewFile('${esc(filePath)}', ${matches[0].line}, '${qEscaped}')">
          <i data-lucide="file" style="width:11px;height:11px;"></i>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(filePath)}</span>
          <span style="margin-left:auto;color:var(--subtext0);font-weight:400;">${matches.length}</span>
        </div>`;
        for (const m of matches) {
          const qWords = query.trim().split(/\s+/).filter(Boolean);
          const highlightPattern = qWords.length > 1 ? qWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const highlighted = esc(m.text.trimStart()).replace(new RegExp(highlightPattern, 'gi'), match => `<mark>${match}</mark>`);
          html += `<div class="search-result" onclick="viewFile('${esc(filePath)}', ${m.line}, '${qEscaped}')">
            <span class="search-result-line">L${m.line}</span>
            <div class="search-result-text">${highlighted}</div>
          </div>`;
        }
      }
      resultsEl.innerHTML = html;
    }
    try {
      lucide.createIcons();
    } catch (_) {}
  } catch (e) {
    resultsEl.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--red);">Search failed</div>';
  }
}
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'avi'];
state._pendingGoToLine = null; // { line, query } — set before file loads, consumed by Monaco
async function viewFile(filePath, goToLine, highlightQuery) {
  state._pendingGoToLine = goToLine ? {
    line: goToLine,
    query: highlightQuery || null
  } : null;
  const ext = filePath.split('.').pop().toLowerCase();

  // Handle images and videos — show preview, not code
  if (IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) {
    state.filesCurrentFile = {
      name: filePath.split('/').pop(),
      path: filePath,
      ext,
      content: '',
      isMedia: true
    };
    document.getElementById('filesViewerTitle').textContent = state.filesCurrentFile.name;
    document.getElementById('filesToggleEditBtn').style.display = 'none';
    const _revBtn = document.getElementById('filesRevealBtn');
    if (_revBtn) _revBtn.style.display = '';
    document.getElementById('monacoContainer').style.display = 'none';
    document.getElementById('monacoSaveBar').style.display = 'none';
    document.getElementById('filesEmpty').style.display = 'none';

    // Use a media preview container
    const emptyEl = document.getElementById('filesEmpty');
    const monacoEl = document.getElementById('monacoContainer');
    monacoEl.style.display = '';
    const editorDiv = document.getElementById('monacoEditor');
    const serveUrl = `/api/files/serve?repo=${encodeURIComponent(state.filesCurrentRepo)}&path=${encodeURIComponent(filePath)}`;
    if (IMAGE_EXTS.includes(ext)) {
      editorDiv.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:20px;"><img src="${serveUrl}" style="max-width:100%;max-height:100%;border-radius:var(--radius);object-fit:contain;"></div>`;
    } else {
      editorDiv.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:20px;"><video src="${serveUrl}" controls style="max-width:100%;max-height:100%;border-radius:var(--radius);"></video></div>`;
    }
    if (state.monacoEditor) {
      state.monacoEditor.dispose();
      state.monacoEditor = null;
    }
    loadFileTree(state.filesCurrentPath);
    return;
  }
  try {
    const res = await fetch(`/api/files/read?repo=${encodeURIComponent(state.filesCurrentRepo)}&path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    state.filesCurrentFile = data;
    document.getElementById('filesViewerTitle').textContent = data.name;
    setFilesMode('view');
    loadFileTree(state.filesCurrentPath);
  } catch (e) {
    toast('Failed to load file', 'error');
  }
}

// ── File viewer mode switching (view / edit) ────────────────────────────
function setFilesMode(mode) {
  state.filesMode = mode;
  const monacoEl = document.getElementById('monacoContainer');
  const emptyEl = document.getElementById('filesEmpty');
  const saveBar = document.getElementById('monacoSaveBar');
  const toggleBtn = document.getElementById('filesToggleEditBtn');
  const revealBtn = document.getElementById('filesRevealBtn');
  monacoEl.style.display = 'none';
  emptyEl.style.display = 'none';
  saveBar.style.display = 'none';
  if (!state.filesCurrentFile) {
    emptyEl.style.display = '';
    toggleBtn.style.display = 'none';
    if (revealBtn) revealBtn.style.display = 'none';
    return;
  }
  toggleBtn.style.display = '';
  if (revealBtn) revealBtn.style.display = '';
  toggleBtn.textContent = mode === 'edit' ? 'View' : 'Edit';
  monacoEl.style.display = '';
  if (mode === 'edit') {
    saveBar.style.display = 'flex';
    openMonacoFile(state.filesCurrentFile.content, state.filesCurrentFile.ext, false);
  } else {
    openMonacoFile(state.filesCurrentFile.content, state.filesCurrentFile.ext, true);
  }
}
function openMonacoFile(content, ext, readOnly) {
  if (state.monacoReady) {
    createOrUpdateMonaco(content, ext, readOnly);
  } else {
    loadMonaco().then(() => createOrUpdateMonaco(content, ext, readOnly));
  }
}
function createOrUpdateMonaco(content, ext, readOnly) {
  const lang = getMonacoLang(ext);
  if (state.monacoEditor) {
    const model = state.monacoEditor.getModel();
    monaco.editor.setModelLanguage(model, lang);
    state.monacoEditor.setValue(content);
    state.monacoEditor.updateOptions({
      readOnly
    });
  } else {
    state.monacoEditor = monaco.editor.create(document.getElementById('monacoEditor'), {
      value: content,
      language: lang,
      theme: 'symphonee',
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
      minimap: {
        enabled: true
      },
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      automaticLayout: true,
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      bracketPairColorization: {
        enabled: true
      },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: {
        top: 8
      },
      readOnly
    });
    state.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (!state.monacoEditor.getOption(monaco.editor.EditorOption.readOnly)) saveFilesEdit();
    });
  }

  // Go to line and highlight if pending
  if (state._pendingGoToLine && state.monacoEditor) {
    const {
      line,
      query
    } = state._pendingGoToLine;
    state._pendingGoToLine = null;
    setTimeout(() => {
      state.monacoEditor.revealLineInCenter(line);
      state.monacoEditor.setPosition({
        lineNumber: line,
        column: 1
      });

      // Highlight the line
      const decorations = [{
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'monaco-highlight-line',
          overviewRuler: {
            color: '#f9e2af80',
            position: monaco.editor.OverviewRulerLane.Full
          }
        }
      }];

      // Also highlight query matches on that line if we have a query
      if (query) {
        const model = state.monacoEditor.getModel();
        const lineContent = model.getLineContent(line);
        const qLower = query.toLowerCase();
        let idx = 0;
        while (idx < lineContent.length) {
          const pos = lineContent.toLowerCase().indexOf(qLower, idx);
          if (pos === -1) break;
          decorations.push({
            range: new monaco.Range(line, pos + 1, line, pos + 1 + query.length),
            options: {
              inlineClassName: 'monaco-highlight-match'
            }
          });
          idx = pos + 1;
        }
      }

      // Apply decorations (auto-clear after 5 seconds)
      const ids = state.monacoEditor.deltaDecorations([], decorations);
      setTimeout(() => {
        if (state.monacoEditor) state.monacoEditor.deltaDecorations(ids, []);
      }, 5000);
    }, 50);
  }
}
function toggleFilesEdit() {
  setFilesMode(state.filesMode === 'edit' ? 'view' : 'edit');
}
state.monacoEditor = null;
state.monacoReady = false; // Detect whether the active theme is light by reading --base's luminance.
function _isLightTheme() {
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--base').trim();
    const m = bg.match(/^#([0-9a-f]{6})$/i);
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = n >> 16 & 0xff,
      g = n >> 8 & 0xff,
      b = n & 0xff;
    // Perceived luminance (Rec. 601)
    return 0.299 * r + 0.587 * g + 0.114 * b > 160;
  } catch (_) {
    return false;
  }
}
function _defineMonacoTheme() {
  if (!window.monaco) return;
  const cs = getComputedStyle(document.documentElement);
  const base = _isLightTheme() ? 'vs' : 'vs-dark';
  monaco.editor.defineTheme('symphonee', {
    base,
    inherit: true,
    rules: [],
    colors: {
      'editor.background': cs.getPropertyValue('--crust').trim(),
      'editor.lineHighlightBackground': cs.getPropertyValue('--surface0').trim(),
      'editorLineNumber.foreground': cs.getPropertyValue('--overlay0').trim()
    }
  });
  if (state.monacoEditor) monaco.editor.setTheme('symphonee');
}
function loadMonaco() {
  if (state.monacoReady) return Promise.resolve();
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs/loader.min.js';
    script.onload = () => {
      require.config({
        paths: {
          vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs'
        }
      });
      require(['vs/editor/editor.main'], () => {
        state.monacoReady = true;
        _defineMonacoTheme();

        // Configure TypeScript/JavaScript to not flag unresolved imports
        const tsDefaults = monaco.languages.typescript.typescriptDefaults;
        const jsDefaults = monaco.languages.typescript.javascriptDefaults;
        const compilerOptions = {
          target: monaco.languages.typescript.ScriptTarget.ESNext,
          module: monaco.languages.typescript.ModuleKind.ESNext,
          moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
          jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
          allowJs: true,
          allowSyntheticDefaultImports: true,
          esModuleInterop: true,
          skipLibCheck: true,
          strict: false,
          noEmit: true,
          isolatedModules: true,
          resolveJsonModule: true,
          baseUrl: '.'
        };
        tsDefaults.setCompilerOptions(compilerOptions);
        jsDefaults.setCompilerOptions(compilerOptions);

        // Disable semantic validation (can't resolve node_modules from browser)
        tsDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: false
        });
        jsDefaults.setDiagnosticsOptions({
          noSemanticValidation: true,
          noSyntaxValidation: false
        });
        resolve();
      });
    };
    document.head.appendChild(script);
  });
}
function getMonacoLang(ext) {
  const map = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    sql: 'sql',
    php: 'php',
    dockerfile: 'dockerfile',
    r: 'r',
    swift: 'swift',
    kt: 'kotlin'
  };
  return map[ext] || 'plaintext';
}
state.monacoDiffEditor = null;
let diffViewMode = 'inline';
state.diffViewCommit = null; // { hash, files: [{file, status}], selectedFile }
async function viewCommitDiff(hash) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  try {
    // Get commit diff stat (file list)
    const statRes = await fetch(`/api/git/commit-diff?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`);
    const statData = await statRes.json();
    if (statData.error) {
      toast(statData.error, 'error');
      return;
    }

    // Parse changed files from diff
    const files = [];
    const diffLines = (statData.diff || '').split('\n');
    let currentFile = null;
    for (const line of diffLines) {
      // Parse "diff --git a/path b/path" — the two paths are always identical, so split on " b/" from the middle
      const m = line.match(/^diff --git a\/(.+)/);
      if (m) {
        const rest = m[1];
        // The path appears twice separated by " b/" — find the midpoint
        const mid = rest.lastIndexOf(' b/');
        const filePath = mid > 0 ? rest.substring(mid + 3) : rest;
        if (!files.find(f => f.file === filePath)) {
          files.push({
            file: filePath,
            status: 'M'
          });
        }
      }
    }
    // Also parse from stat
    if (statData.stat) {
      const statLines = statData.stat.split('\n');
      for (const sl of statLines) {
        const sm = sl.match(/^\s*(.+?)\s+\|\s+\d+/);
        if (sm && !files.find(f => f.file === sm[1].trim())) {
          files.push({
            file: sm[1].trim(),
            status: 'M'
          });
        }
      }
    }
    state.diffViewCommit = {
      hash,
      diff: statData.diff,
      message: statData.message,
      files,
      repo
    };

    // Show the tab
    document.getElementById('diffviewTabBtn').style.display = '';
    document.getElementById('diffviewTitle').textContent = `Commit ${hash}: ${statData.message || ''}`;

    // Render file list
    const fileList = document.getElementById('diffviewFileList');
    document.getElementById('diffviewFileCount').textContent = `${files.length} files`;
    fileList.innerHTML = files.map((f, i) => `
      <div class="diffview-file ${i === 0 ? 'active' : ''}" onclick="selectDiffFile(${i})" data-idx="${i}">
        <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
        <span class="diffview-file-name" title="${esc(f.file)}">${esc(f.file.split('/').pop())}</span>
      </div>
    `).join('');
    switchTab('diffview');

    // Show first file's diff
    if (files.length > 0) renderDiffForFile(0);else renderDiffViewContent(statData.diff);
  } catch (e) {
    toast('Failed to load commit diff', 'error');
  }
}
function selectDiffFile(idx) {
  document.querySelectorAll('.diffview-file').forEach(el => el.classList.toggle('active', parseInt(el.dataset.idx) === idx));
  renderDiffForFile(idx);
}
async function renderDiffForFile(idx) {
  if (!state.diffViewCommit) return;
  const file = state.diffViewCommit.files[idx];
  if (!file) return;
  document.getElementById('diffviewTitle').textContent = file.file;
  const container = document.getElementById('diffviewContent');
  container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="spinner"></div></div>';
  const repo = state.diffViewCommit.repo;
  if (state.diffViewCommit.hash && state.diffViewCommit.hash !== 'working') {
    // Viewing a commit — extract this file's diff from the full commit diff
    const fileDiff = extractFileDiff(state.diffViewCommit.diff, file.file);
    if (fileDiff) {
      renderInlineDiff(container, fileDiff);
    } else {
      // Fallback: fetch from commit-diff endpoint for just this file
      try {
        const res = await fetch(`/api/git/commit-diff?repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(state.diffViewCommit.hash)}&path=${encodeURIComponent(file.file)}`);
        const data = await res.json();
        renderInlineDiff(container, data.diff);
      } catch (_) {
        container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">Failed to load diff</div></div>';
      }
    }
  } else {
    // Working tree — fetch live diff
    try {
      const res = await fetch(`/api/git/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(file.file)}`);
      const data = await res.json();
      renderInlineDiff(container, data.diff);
    } catch (_) {
      container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">Failed to load diff</div></div>';
    }
  }
}

// Extract the diff chunk for a specific file from a full multi-file diff
function extractFileDiff(fullDiff, filePath) {
  if (!fullDiff) return null;
  const lines = fullDiff.split('\n');
  let capturing = false;
  let result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      if (capturing) break; // hit the next file, stop
      // Check if this is the file we want
      const m = line.match(/^diff --git a\/(.+)/);
      if (m) {
        const rest = m[1];
        const mid = rest.lastIndexOf(' b/');
        const diffFile = mid > 0 ? rest.substring(mid + 3) : rest;
        if (diffFile === filePath) capturing = true;
      }
    }
    if (capturing) result.push(line);
  }
  return result.length > 0 ? result.join('\n') : null;
}
function renderInlineDiff(container, diffText) {
  if (state.monacoDiffEditor) {
    state.monacoDiffEditor.dispose();
    state.monacoDiffEditor = null;
  }
  if (!diffText || diffText === 'No changes') {
    container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-text">No changes</div></div>';
    return;
  }
  const lines = diffText.split('\n');
  let added = 0,
    removed = 0;
  let html = '<table class="diff-table"><tbody>';
  for (const line of lines) {
    if (line.startsWith('@@')) {
      html += `<tr class="diff-hunk"><td colspan="3">${esc(line)}</td></tr>`;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
      html += `<tr class="diff-add"><td class="diff-marker">+</td><td class="diff-code">${esc(line.slice(1))}</td></tr>`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
      html += `<tr class="diff-remove"><td class="diff-marker">-</td><td class="diff-code">${esc(line.slice(1))}</td></tr>`;
    } else if (!line.startsWith('diff ') && !line.startsWith('index ') && !line.startsWith('---') && !line.startsWith('+++')) {
      html += `<tr><td class="diff-marker"></td><td class="diff-code">${esc(line.startsWith(' ') ? line.slice(1) : line)}</td></tr>`;
    }
  }
  html += '</tbody></table>';
  container.innerHTML = `<div class="diff-stats-bar"><span class="diff-stats-add">+${added}</span> <span class="diff-stats-del">-${removed}</span></div>${html}`;
}
function populateDiffTabWithChanges(files, repo) {
  if (!files || files.length === 0) return;
  state.diffViewCommit = {
    hash: 'working',
    diff: '',
    message: 'Working changes',
    files: files.map(f => ({
      file: f.file,
      status: f.status
    })),
    repo
  };
  document.getElementById('diffviewTitle').textContent = 'Working Changes';
  document.getElementById('diffviewFileCount').textContent = `${files.length} files`;
  const fileList = document.getElementById('diffviewFileList');
  fileList.innerHTML = state.diffViewCommit.files.map((f, i) => `
    <div class="diffview-file" onclick="selectDiffFile(${i})" oncontextmenu="event.preventDefault();showDiffFileContextMenu(event,'${esc(f.file).replace(/'/g, "\\'")}')" data-idx="${i}">
      <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
      <span class="diffview-file-name" title="${esc(f.file)}">${esc(f.file.split('/').pop())}</span>
    </div>
  `).join('');

  // Pre-load the full diff
  fetch(`/api/git/diff?repo=${encodeURIComponent(repo)}`).then(r => r.json()).then(data => {
    if (state.diffViewCommit && state.diffViewCommit.hash === 'working') state.diffViewCommit.diff = data.diff || '';
  }).catch(() => {});
}
function closeDiffView() {
  document.getElementById('diffviewTabBtn').style.display = 'none';
  if (state.monacoDiffEditor) {
    state.monacoDiffEditor.dispose();
    state.monacoDiffEditor = null;
  }
  state.diffViewCommit = null;
  switchTab('terminal');
}
state.contextDiffFile = null;
function showDiffFileContextMenu(e, filePath) {
  e.preventDefault();
  state.contextDiffFile = filePath;
  const menu = document.getElementById('diffFileContextMenu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('open');
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
}
async function discardFileFromContext() {
  document.getElementById('diffFileContextMenu').classList.remove('open');
  if (!state.contextDiffFile) return;
  const repo = state.diffViewCommit && state.diffViewCommit.repo || state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const ok = await customConfirm('Discard Changes', `Discard all changes to "${state.contextDiffFile}"? This cannot be undone.`, 'Discard');
  if (!ok) return;
  try {
    const r = await fetch('/api/git/discard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo,
        path: state.contextDiffFile
      })
    });
    const data = await r.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    toast(`Discarded changes to ${state.contextDiffFile}`);
    // Refresh the current view
    if (state.diffViewCommit && state.diffViewCommit.hash === 'working') {
      const remaining = state.diffViewCommit.files.filter(f => f.file !== state.contextDiffFile);
      if (remaining.length > 0) {
        viewChangedFile(remaining[0].file);
      } else {
        closeDiffView();
      }
    }
    // Refresh the files tab changed list
    if (typeof loadGitPanel === 'function' && state.filesCurrentRepo) loadGitPanel();
  } catch (e) {
    toast('Failed to discard changes', 'error');
  }
}
async function viewChangedFile(filePath) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  try {
    // Get all changed files and the diff
    const statusRes = await fetch(`/api/git/status?repo=${encodeURIComponent(repo)}`);
    const statusData = await statusRes.json();
    const diffRes = await fetch(`/api/git/diff?repo=${encodeURIComponent(repo)}`);
    const diffData = await diffRes.json();
    const files = (statusData.files || []).map(f => ({
      file: f.file,
      status: f.status
    }));
    state.diffViewCommit = {
      hash: 'working',
      diff: diffData.diff,
      message: 'Working changes',
      files,
      repo
    };
    document.getElementById('diffviewTabBtn').style.display = '';
    document.getElementById('diffviewTitle').textContent = 'Working Changes';
    document.getElementById('diffviewFileCount').textContent = `${files.length} files`;
    const fileList = document.getElementById('diffviewFileList');
    const targetIdx = files.findIndex(f => f.file === filePath);
    fileList.innerHTML = files.map((f, i) => `
      <div class="diffview-file ${i === (targetIdx >= 0 ? targetIdx : 0) ? 'active' : ''}" onclick="selectDiffFile(${i})" oncontextmenu="event.preventDefault();showDiffFileContextMenu(event,'${esc(f.file).replace(/'/g, "\\'")}')" data-idx="${i}">
        <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
        <span class="diffview-file-name" title="${esc(f.file)}">${esc(f.file.split('/').pop())}</span>
      </div>
    `).join('');
    switchTab('diffview');
    renderDiffForFile(targetIdx >= 0 ? targetIdx : 0);
  } catch (e) {
    toast('Failed to load diff', 'error');
  }
}
function cancelFilesEdit() {
  setFilesMode('view');
}
async function saveFilesEdit() {
  const content = state.monacoEditor ? state.monacoEditor.getValue() : '';
  try {
    const res = await fetch('/api/files/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo: state.filesCurrentRepo,
        path: state.filesCurrentFile.path,
        content
      })
    });
    const data = await res.json();
    if (data.ok) {
      toast('File saved', 'success');
      state.filesCurrentFile.content = content;
      cancelFilesEdit();
      viewFile(state.filesCurrentFile.path);
    } else {
      toast(data.error || 'Failed to save', 'error');
    }
  } catch (e) {
    toast('Failed to save', 'error');
  }
}

// ── Files Sidebar Tabs ──────────────────────────────────────────────────
function switchFilesTab(tab) {
  document.querySelectorAll('.files-stab').forEach(el => el.classList.toggle('active', el.dataset.fstab === tab));
  document.querySelectorAll('.files-stab-panel').forEach(el => el.classList.toggle('active', el.id === `fstab-${tab}`));
  if (tab === 'git' && state.filesCurrentRepo) loadGitPanel();
  if (tab === 'log' && state.filesCurrentRepo) loadGitLog();
}
async function loadGitPanel() {
  if (!state.filesCurrentRepo) return;

  // Load branches
  try {
    const res = await fetch(`/api/git/branches?repo=${encodeURIComponent(state.filesCurrentRepo)}`);
    const data = await res.json();
    if (!data.error) {
      const select = document.getElementById('filesBranchSelect');
      select.innerHTML = data.branches.map(b => `<option value="${esc(b)}" ${b === data.current ? 'selected' : ''}>${esc(b)}</option>`).join('');
    }
  } catch (_) {}

  // Load changed files
  try {
    const res = await fetch(`/api/git/status?repo=${encodeURIComponent(state.filesCurrentRepo)}`);
    const git = await res.json();
    const container = document.getElementById('filesChangedList');
    if (git.files && git.files.length > 0) {
      container.innerHTML = git.files.map(f => `
        <div class="changed-file" onclick="viewFile('${esc(f.file)}')" oncontextmenu="event.preventDefault();showDiffFileContextMenu(event,'${esc(f.file).replace(/'/g, "\\'")}')" title="${esc(f.file)}">
          <span class="changed-file-status ${f.statusClass || f.status}">${f.status}</span>
          <span>${esc(f.file.split('/').pop())}</span>
        </div>
      `).join('');
    } else {
      container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);">No changes</div>';
    }
  } catch (_) {}
}
async function loadGitLogPanel() {
  // Use the active repo, falling back to the Files-tab repo. On load only
  // activeRepo is restored (from localStorage); filesCurrentRepo starts empty
  // until a Files-tab interaction, which left this panel stuck on its
  // "Select a repo" placeholder even with a repo selected on the left.
  const repo = state.filesCurrentRepo || state.activeRepo;
  const container = document.getElementById('gitLogList');
  if (!repo) {
    if (container) container.innerHTML = '<div style="color:var(--subtext0);font-size:12px;padding:4px;">Select a repository</div>';
    return;
  }
  try {
    const res = await fetch(`/api/git/log?repo=${encodeURIComponent(repo)}&count=30`);
    const data = await res.json();
    if (data.commits && data.commits.length > 0) {
      container.innerHTML = data.commits.map(c => `
        <div class="commit-item" onclick="viewCommitDiff('${esc(c.hash)}')" style="cursor:pointer;" title="View changes in this commit">
          <span class="commit-hash">${esc(c.hash)}</span>
          <div class="commit-msg">${esc(c.subject)}</div>
          <div class="commit-meta">${esc(c.author)} - ${esc(c.date)}</div>
        </div>
      `).join('');
    } else {
      container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:10px;text-align:center;">No commits</div>';
    }
  } catch (_) {
    container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:10px;text-align:center;">Failed to load</div>';
  }
}
function switchBranch(branch) {
  if (!state.filesCurrentRepo || !branch) return;
  // This is a write action — send to terminal for the user/AI to confirm
  switchTab('terminal');
  sendCommand(`cd "${state.configData.Repos[state.filesCurrentRepo]}"; git checkout ${branch}`);
  toast(`Switching to ${branch}...`, 'info');
}
function aiGit(action) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) {
    toast('Select a repo first', 'info');
    return;
  }
  const repoPath = state.configData.Repos[repo];
  const user = state.configData.DefaultUser || 'the user';
  const prompts = {
    pull: `In the repo at "${repoPath}", pull the latest changes from the remote. Run: cd "${repoPath}" && git pull`,
    push: `In the repo at "${repoPath}", push the current branch to the remote. Run: cd "${repoPath}" && git push`,
    checkout: `In the repo at "${repoPath}", list all branches and ask me which one I want to switch to. Run: cd "${repoPath}" && git branch -a`,
    commit: `In the repo at "${repoPath}", check git status, show me what changed, suggest a commit message, and create the commit. The commit must be signed by "${user}". Run: cd "${repoPath}" && git status`,
    compare: `In the repo at "${repoPath}", compare the current branch with main. Show a summary of all differences. Run: cd "${repoPath}" && git diff main...HEAD --stat`
  };
  askAi(prompts[action]);
}

// ── Context picker modals ─────────────────────────────────────────────────

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// Space picker
async function openSpaceModal() {
  const modal = document.getElementById('spaceModal');
  const list = document.getElementById('spacePickList');
  if (!modal || !list) return;
  modal.classList.add('open');
  list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);">Loading...</div>';
  let spaces = {},
    repos = {};
  try {
    [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
  } catch (_) {}
  const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';
  const allActive = !state.activeSpace ? ' active' : '';
  html += `<div class="ctx-pick-item${allActive}" role="button" tabindex="0" data-pick-space="__all__">
    <i data-lucide="layers" style="width:15px;height:15px;"></i>
    <span class="cpi-name">All spaces</span>
  </div>`;
  for (const [name, sv] of Object.entries(spaces)) {
    const icon = sv && sv.icon || 'layers';
    const count = sv && Array.isArray(sv.repos) ? sv.repos.filter(r => repos[r]).length : 0;
    const active = name === state.activeSpace ? ' active' : '';
    html += `<div class="ctx-pick-item${active}" role="button" tabindex="0" data-pick-space="${escAttr(name)}">
      <i data-lucide="${esc(icon)}" style="width:15px;height:15px;"></i>
      <span class="cpi-name">${esc(name)}</span>
      ${count ? `<span class="cpi-sub">${count} repo${count !== 1 ? 's' : ''}</span>` : ''}
      <button type="button" class="cpi-action" data-pick-action="edit-space" data-space-name="${escAttr(name)}" title="Edit space settings" aria-label="Edit space settings">
        <i data-lucide="settings"></i>
      </button>
    </div>`;
  }
  if (!Object.keys(spaces).length) {
    html += '<div style="padding:12px 14px;font-size:11px;color:var(--subtext0);">No spaces yet. Create one below.</div>';
  }
  list.innerHTML = html;
  list.onclick = function (ev) {
    const action = ev.target && ev.target.closest && ev.target.closest('[data-pick-action]');
    if (action) {
      ev.preventDefault();
      ev.stopPropagation();
      const kind = action.getAttribute('data-pick-action');
      if (kind === 'edit-space') {
        const n = action.getAttribute('data-space-name') || '';
        closeModal('spaceModal');
        try {
          openEditSpaceDialog(n);
        } catch (e) {
          console.error('openEditSpaceDialog failed', e);
        }
      }
      return;
    }
    const btn = ev.target && ev.target.closest && ev.target.closest('[data-pick-space]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const raw = btn.getAttribute('data-pick-space') || '';
    const n = raw === '__all__' ? '' : raw;
    try {
      selectSpace(n);
    } catch (e) {
      console.error('selectSpace failed', e);
    }
    closeModal('spaceModal');
  };
  try {
    lucide.createIcons({
      nodes: [list]
    });
  } catch (_) {}
}

// Repo picker (filtered to current space)
state._repoPickNames = [];
async function openRepoModal() {
  const modal = document.getElementById('repoModal');
  const list = document.getElementById('repoPickList');
  const title = document.getElementById('repoModalTitle');
  const search = document.getElementById('repoPickSearch');
  if (!modal || !list) return;
  modal.classList.add('open');
  if (search) search.value = '';
  list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);">Loading...</div>';
  if (title) title.textContent = state.activeSpace ? `Repos in "${state.activeSpace}"` : 'Select Repo';
  let repos = {},
    spaces = {};
  try {
    [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
  } catch (_) {}
  // Filter repos to current space if one is selected
  let repoNames = Object.keys(repos);
  if (state.activeSpace && spaces[state.activeSpace] && Array.isArray(spaces[state.activeSpace].repos)) {
    repoNames = spaces[state.activeSpace].repos.filter(r => repos[r]);
  }
  state._repoPickNames = repoNames;
  renderRepoPicker('');
  list.onclick = function (ev) {
    const action = ev.target && ev.target.closest && ev.target.closest('[data-pick-action]');
    if (action) {
      ev.preventDefault();
      ev.stopPropagation();
      const kind = action.getAttribute('data-pick-action');
      if (kind === 'reveal-repo') {
        const n = action.getAttribute('data-repo-name') || '';
        if (!n) return;
        fetch('/api/ui/reveal', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'file',
            repo: n,
            path: ''
          })
        }).then(r => r.json().catch(() => ({}))).then(d => {
          if (d && d.error) toast(d.error, 'error');
        }).catch(() => toast('Could not open folder', 'error'));
      }
      return;
    }
    const btn = ev.target && ev.target.closest && ev.target.closest('[data-pick-repo]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const n = btn.getAttribute('data-pick-repo') || '';
    try {
      selectRepo(n);
    } catch (e) {
      console.error('selectRepo failed', e);
    }
    closeModal('repoModal');
  };
  if (search) setTimeout(() => search.focus(), 50);
}
function renderRepoPicker(filter) {
  const list = document.getElementById('repoPickList');
  if (!list) return;
  const f = (filter || '').toLowerCase();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const filtered = state._repoPickNames.filter(n => !f || n.toLowerCase().includes(f));

  // "No repo" row always present (unless filtering hides it) so user can clear the selection
  const noRepoMatches = !f || 'no repo'.includes(f);
  let html = '';
  if (noRepoMatches) {
    const active = !state.activeRepo ? ' active' : '';
    html += `<div class="ctx-pick-item${active}" role="button" tabindex="0" data-pick-repo="">
      <i data-lucide="folder-x" style="width:15px;height:15px;"></i>
      <span class="cpi-name" style="color:var(--subtext0);font-style:italic;">No repo</span>
    </div>`;
  }
  for (const name of filtered) {
    const active = name === state.activeRepo ? ' active' : '';
    html += `<div class="ctx-pick-item${active}" role="button" tabindex="0" data-pick-repo="${escAttr(name)}">
      <i data-lucide="folder-git-2" style="width:15px;height:15px;"></i>
      <span class="cpi-name">${esc(name)}</span>
      <button type="button" class="cpi-action" data-pick-action="reveal-repo" data-repo-name="${escAttr(name)}" title="Open folder in Explorer" aria-label="Open folder in Explorer">
        <i data-lucide="folder-open"></i>
      </button>
    </div>`;
  }
  if (!filtered.length && !noRepoMatches) {
    html = `<div style="padding:12px 14px;font-size:11px;color:var(--subtext0);">No repos match "${esc(filter)}".</div>`;
  } else if (!state._repoPickNames.length && !f) {
    html += `<div style="padding:12px 14px 4px;font-size:11px;color:var(--subtext0);">${state.activeSpace ? 'No repos in this space.' : 'No repos added yet.'}</div>`;
    html += `<div style="padding:4px 14px 12px;"><button type="button" onclick="document.getElementById('repoModal').classList.remove('open'); if(typeof openSettings==='function') openSettings('repos');" style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;background:var(--surface1);border:1px solid var(--surface2);border-radius:var(--radius);color:var(--text);font:600 11px var(--font-ui);cursor:pointer;"><i data-lucide="plus" style="width:13px;height:13px;"></i> Add a repo</button></div>`;
  }
  list.innerHTML = html;
  try {
    lucide.createIcons({
      nodes: [list]
    });
  } catch (_) {}
}
function filterRepoPicker() {
  const search = document.getElementById('repoPickSearch');
  renderRepoPicker(search ? search.value : '');
}

// Branch picker
state._branchPickData = {
  local: [],
  remoteOnly: [],
  current: ''
};
state._branchFilter = 'all';
function setBranchFilter(f) {
  state._branchFilter = f;
  ['all', 'local', 'remote'].forEach(k => {
    const el = document.getElementById('branchFilter' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.classList.toggle('active', k === f);
  });
  filterBranchPicker();
}
async function openBranchModal() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) {
    toast('Select a repo first', 'info');
    return;
  }
  const modal = document.getElementById('branchModal');
  const repoEl = document.getElementById('branchModalRepo');
  const list = document.getElementById('branchPickList');
  const search = document.getElementById('branchPickSearch');
  if (!modal || !list) return;
  if (repoEl) repoEl.textContent = repo;
  if (search) search.value = '';
  state._branchFilter = 'all';
  ['All', 'Local', 'Remote'].forEach(k => {
    const el = document.getElementById('branchFilter' + k);
    if (el) el.classList.toggle('active', k === 'All');
  });
  modal.classList.add('open');
  list.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--subtext0);">Loading branches...</div>';
  try {
    const r = await fetch('/api/git/branches?repo=' + encodeURIComponent(repo));
    const data = await r.json();
    // API returns either { local, remoteOnly, current } or legacy { branches, current }
    state._branchPickData = {
      local: data.local || data.branches || [],
      remoteOnly: data.remoteOnly || [],
      current: data.current || ''
    };
    renderBranchPicker('');
  } catch (e) {
    list.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--red);">${e.message}</div>`;
  }
}
function renderBranchPicker(filter) {
  const list = document.getElementById('branchPickList');
  if (!list) return;
  const f = (filter || '').toLowerCase();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';

  // ensure current branch is always in the local list
  const allLocals = state._branchPickData.local.slice();
  if (state._branchPickData.current && !allLocals.includes(state._branchPickData.current)) {
    allLocals.unshift(state._branchPickData.current);
  }
  if (state._branchFilter !== 'remote') {
    const locals = allLocals.filter(b => !f || b.toLowerCase().includes(f));
    for (const b of locals) {
      const isCurrent = b === state._branchPickData.current;
      const icon = isCurrent ? 'check' : 'git-branch';
      const onclick = isCurrent ? '' : `onclick="doGitCheckoutFromModal(${JSON.stringify(b)});"`;
      html += `<button class="branch-pick-item${isCurrent ? ' current' : ''}" ${onclick}>
        <i data-lucide="${icon}" style="width:14px;height:14px;"></i>
        <span class="bp-name">${esc(b)}</span>
        <span class="branch-badge ${isCurrent ? 'current-badge' : 'local'}">${isCurrent ? 'current' : 'local'}</span>
      </button>`;
    }
  }
  if (state._branchFilter !== 'local') {
    const remotes = (state._branchPickData.remoteOnly || []).filter(b => !f || b.toLowerCase().includes(f));
    for (const b of remotes) {
      html += `<button class="branch-pick-item" onclick="doGitCheckoutFromModal(${JSON.stringify(b)});">
        <i data-lucide="cloud" style="width:14px;height:14px;"></i>
        <span class="bp-name">${esc(b)}</span>
        <span class="branch-badge remote">remote</span>
      </button>`;
    }
  }
  if (!html) html = '<div style="padding:12px;font-size:11px;color:var(--subtext0);">No branches match.</div>';
  list.innerHTML = html;
  try {
    lucide.createIcons({
      nodes: [list]
    });
  } catch (_) {}
}
async function doGitCheckoutFromModal(branch) {
  closeModal('branchModal');
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo || !branch) return;
  toast('Switching to ' + branch + '...', 'info');
  try {
    const res = await fetch('/api/git/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo,
        branch
      })
    });
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    let msg = 'Switched to ' + data.branch;
    if (data.pullMessage && data.pullMessage !== 'Already up to date.') msg += ' — pulled latest';
    toast(msg, 'success');
    // update all branch displays
    state._gitBranches.current = data.branch;
    refreshBranchChip(repo);
    const cur = document.getElementById('gitCurrentBranch');
    const pull = document.getElementById('gitPullBranch');
    const push = document.getElementById('gitPushBranch');
    if (cur) cur.textContent = data.branch;
    if (pull) pull.textContent = data.branch;
    if (push) push.textContent = data.branch;
    const sidebarBranch = document.getElementById('repoSidebarBranch');
    if (sidebarBranch) sidebarBranch.textContent = data.branch;
    const searchEl = document.getElementById('gitBranchSearch');
    renderGitBranches(searchEl ? searchEl.value : '');
    if (typeof loadFileTree === 'function') loadFileTree(repo);
  } catch (e) {
    toast('Checkout failed: ' + e.message, 'error');
  }
}
function filterBranchPicker() {
  const el = document.getElementById('branchPickSearch');
  renderBranchPicker(el ? el.value : '');
}// ── Git Modal ────────────────────────────────────────────────────────────
state._gitBranches = {
  local: [],
  remoteOnly: [],
  current: ''
};
function openGitModal(tab) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) {
    toast('Select a repo first', 'info');
    return;
  }
  document.getElementById('gitModalRepo').textContent = repo;
  document.getElementById('gitModal').classList.add('open');
  document.getElementById('gitBranchSearch').value = '';
  document.getElementById('gitPullResult').style.display = 'none';
  document.getElementById('gitPushResult').style.display = 'none';
  document.getElementById('gitPullBtn').disabled = false;
  document.getElementById('gitPullBtn').textContent = 'Pull';
  document.getElementById('gitPushBtn').disabled = false;
  document.getElementById('gitPushBtn').textContent = 'Push';
  // Reset commit fields
  document.getElementById('gitCommitTitle').value = '';
  document.getElementById('gitCommitBody').value = '';
  document.getElementById('gitCommitBtn').disabled = false;
  document.getElementById('gitCommitBtn').textContent = 'Commit';
  setCommitMode('custom');
  // Reset to requested tab
  const tabId = tab || 'branches';
  const btns = document.querySelectorAll('.git-nav-btn');
  const tabs = document.querySelectorAll('.git-tab');
  btns.forEach(b => b.classList.remove('active'));
  tabs.forEach(t => t.classList.remove('active'));
  document.getElementById('gitTab-' + tabId).classList.add('active');
  // Match nav button by tab keyword
  const tabKeywords = {
    branches: 'branch',
    pull: 'pull',
    push: 'push',
    commit: 'commit',
    compare: 'compare'
  };
  const kw = tabKeywords[tabId] || tabId;
  btns.forEach(b => {
    if (b.textContent.trim().toLowerCase().startsWith(kw)) b.classList.add('active');
  });
  loadGitBranches();
  // Load commit file list when opening commit tab
  if (tabId === 'commit') loadCommitFileList();
  lucide.createIcons();
}
function closeGitModal() {
  document.getElementById('gitModal').classList.remove('open');
}
function switchGitTab(tabId, btn) {
  document.querySelectorAll('.git-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.git-nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('gitTab-' + tabId).classList.add('active');
  if (btn) btn.classList.add('active');
  if (tabId === 'commit') loadCommitFileList();
}
async function loadGitBranches() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const list = document.getElementById('gitBranchList');
  list.innerHTML = '<div class="git-section-desc">Fetching branches...</div>';
  const taskId = addBackgroundTask('git-fetch-' + Date.now(), 'Fetching branches', 'git-branch');
  try {
    // Fetch from remote first to get latest branches
    const fetchRes = await fetch('/api/git/fetch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo
      })
    });
    const data = await fetchRes.json();
    if (data.error) throw new Error(data.error);
    state._gitBranches = data;
    document.getElementById('gitCurrentBranch').textContent = data.current;
    document.getElementById('gitPullBranch').textContent = data.current;
    document.getElementById('gitPushBranch').textContent = data.current;
    document.getElementById('gitCommitBranch').textContent = data.current;
    populateCompareDropdowns(data);
    renderGitBranches();
    completeBackgroundTask(taskId, true);
  } catch (e) {
    list.innerHTML = `<div class="git-section-desc" style="color:var(--red);">${e.message}</div>`;
    completeBackgroundTask(taskId, false);
  }
}
function renderGitBranches(filter) {
  const list = document.getElementById('gitBranchList');
  const f = (filter || '').toLowerCase();
  let html = '';

  // Local branches first
  const locals = state._gitBranches.local.filter(b => !f || b.toLowerCase().includes(f));
  for (const b of locals) {
    const isCurrent = b === state._gitBranches.current;
    html += `<div class="git-branch-item ${isCurrent ? 'current' : ''}" ${isCurrent ? '' : `onclick="doGitCheckout('${b.replace(/'/g, "\\'")}')"`}>
      <i data-lucide="${isCurrent ? 'check' : 'git-branch'}" style="width:13px;height:13px;flex-shrink:0;${isCurrent ? 'color:var(--green);' : 'color:var(--subtext0);'}"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${b}</span>
      ${isCurrent ? '<span class="branch-badge current-badge">current</span>' : '<span class="branch-badge local">local</span>'}
    </div>`;
  }

  // Remote-only branches
  const remotes = (state._gitBranches.remoteOnly || []).filter(b => !f || b.toLowerCase().includes(f));
  if (remotes.length > 0) {
    for (const b of remotes) {
      html += `<div class="git-branch-item" onclick="doGitCheckout('${b.replace(/'/g, "\\'")}')">
        <i data-lucide="cloud" style="width:13px;height:13px;flex-shrink:0;color:var(--subtext0);"></i>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${b}</span>
        <span class="branch-badge remote">remote</span>
      </div>`;
    }
  }
  if (!html) {
    html = '<div class="git-section-desc">No branches match your filter.</div>';
  }
  list.innerHTML = html;
  lucide.createIcons();
}
function filterGitBranches() {
  const val = document.getElementById('gitBranchSearch').value;
  renderGitBranches(val);
}
async function doGitCheckout(branch) {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo || !branch) return;
  if (branch === state._gitBranches.current) return;

  // Show a switching status in the branch list
  const list = document.getElementById('gitBranchList');
  const prevHtml = list.innerHTML;
  list.innerHTML = '<div class="git-section-desc">Switching branch, fetching & pulling...</div>';
  try {
    const res = await fetch('/api/git/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo,
        branch
      })
    });
    const data = await res.json();
    if (data.error) {
      list.innerHTML = prevHtml;
      toast(data.error, 'error');
      return;
    }
    let msg = `Switched to ${data.branch}`;
    if (data.pullMessage && data.pullMessage !== 'Already up to date.') {
      msg += ' (pulled latest)';
    }
    toast(msg, 'success');
    state._gitBranches.current = data.branch;
    document.getElementById('gitCurrentBranch').textContent = data.branch;
    document.getElementById('gitPullBranch').textContent = data.branch;
    document.getElementById('gitPushBranch').textContent = data.branch;
    // Update sidebar branch display
    const sidebarBranch = document.getElementById('repoSidebarBranch');
    if (sidebarBranch) sidebarBranch.textContent = data.branch;
    renderGitBranches(document.getElementById('gitBranchSearch').value);
    // Refresh file tree if visible
    if (typeof loadFileTree === 'function') loadFileTree(repo);
  } catch (e) {
    list.innerHTML = prevHtml;
    toast('Checkout failed: ' + e.message, 'error');
  }
}
async function doGitPull() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const btn = document.getElementById('gitPullBtn');
  const result = document.getElementById('gitPullResult');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = 'Pulling...';
  const taskId = addBackgroundTask('git-pull-' + Date.now(), 'Pulling ' + repo, 'download');
  result.style.display = 'none';
  try {
    const res = await fetch('/api/git/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    result.textContent = data.message || 'Already up to date.';
    result.className = 'git-action-result success';
    result.style.display = 'block';
    btn.textContent = 'Done';
    toast('Pull complete', 'success');
    document.getElementById('gitPullBranch').textContent = data.branch;
    completeBackgroundTask(taskId, true);
  } catch (e) {
    result.textContent = e.message;
    result.className = 'git-action-result error';
    result.style.display = 'block';
    btn.textContent = 'Retry';
    btn.disabled = false;
    toast('Pull failed', 'error');
    completeBackgroundTask(taskId, false);
  } finally {
    btn.classList.remove('busy');
  }
}
async function doGitPush() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const btn = document.getElementById('gitPushBtn');
  const result = document.getElementById('gitPushResult');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = 'Pushing...';
  result.style.display = 'none';
  const taskId = addBackgroundTask('git-push-' + Date.now(), 'Pushing ' + repo, 'upload');
  try {
    const res = await fetch('/api/git/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo
      })
    });
    const data = await res.json();
    if (data.error) {
      if (data.needsPull) {
        // Behind remote - prompt user to pull first
        result.innerHTML = `${esc(data.error)}<br><button class="btn btn-sm" style="margin-top:8px;" onclick="switchGitTab('pull');doGitPull();">Pull Now</button>`;
        result.className = 'git-action-result error';
        result.style.display = 'block';
        btn.textContent = 'Push';
        btn.disabled = false;
        btn.classList.remove('busy');
        toast('Pull required before pushing', 'warning');
        return;
      }
      throw new Error(data.error);
    }
    result.textContent = data.message || 'Pushed successfully.';
    result.className = 'git-action-result success';
    result.style.display = 'block';
    btn.textContent = 'Done';
    toast('Push complete', 'success');
    document.getElementById('gitPushBranch').textContent = data.branch;
    completeBackgroundTask(taskId, true);
  } catch (e) {
    result.textContent = e.message;
    result.className = 'git-action-result error';
    result.style.display = 'block';
    btn.textContent = 'Retry';
    btn.disabled = false;
    toast('Push failed', 'error');
    completeBackgroundTask(taskId, false);
  } finally {
    btn.classList.remove('busy');
  }
}

// ── Compare & Commit (modal → AI) ───────────────────────────────────────
function populateCompareDropdowns(data) {
  const allBranches = [...data.local, ...(data.remoteOnly || [])];
  const sourceEl = document.getElementById('gitCompareSource');
  const targetEl = document.getElementById('gitCompareTarget');
  let opts = allBranches.map(b => `<option value="${b}"${b === data.current ? ' selected' : ''}>${b}</option>`).join('');
  sourceEl.innerHTML = opts;
  // Target defaults to main/master
  const defaultTarget = allBranches.includes('main') ? 'main' : allBranches.includes('master') ? 'master' : allBranches[0] || '';
  let targetOpts = allBranches.map(b => `<option value="${b}"${b === defaultTarget ? ' selected' : ''}>${b}</option>`).join('');
  targetEl.innerHTML = targetOpts;
}
function doGitCompare() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const repoPath = state.configData.Repos[repo];
  const source = document.getElementById('gitCompareSource').value;
  const target = document.getElementById('gitCompareTarget').value;
  if (!source || !target) {
    toast('Select both branches', 'info');
    return;
  }
  if (source === target) {
    toast('Select two different branches', 'info');
    return;
  }
  closeGitModal();
  askAi(`In the repo at "${repoPath}", compare branch "${source}" with "${target}". Show a summary of all differences — files changed, additions, removals, and key insights about what changed. Run: cd "${repoPath}" && git diff ${target}...${source} --stat`);
}
function setCommitMode(mode) {
  const customBtn = document.getElementById('gitCommitModeCustom');
  const aiBtn = document.getElementById('gitCommitModeAi');
  const customFields = document.getElementById('gitCommitCustomFields');
  const aiNote = document.getElementById('gitCommitAiNote');
  if (mode === 'custom') {
    customBtn.classList.add('active');
    aiBtn.classList.remove('active');
    customFields.style.display = 'block';
    aiNote.style.display = 'none';
  } else {
    customBtn.classList.remove('active');
    aiBtn.classList.add('active');
    customFields.style.display = 'none';
    aiNote.style.display = 'block';
  }
  document.getElementById('gitCommitBtn').dataset.mode = mode;
}
async function loadCommitFileList() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const container = document.getElementById('gitCommitFileList');
  container.innerHTML = '<div class="git-section-desc">Checking for changes...</div>';
  try {
    const res = await fetch(`/api/git/status?repo=${encodeURIComponent(repo)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    document.getElementById('gitCommitBranch').textContent = data.branch;
    if (data.clean) {
      container.innerHTML = '<div class="git-section-desc">No changes to commit.</div>';
      document.getElementById('gitCommitBtn').disabled = true;
      return;
    }
    document.getElementById('gitCommitBtn').disabled = false;
    let html = '<div class="git-commit-file-list">';
    for (const f of data.files) {
      html += `<div class="git-commit-file">
        <span class="file-status ${f.statusClass}">${f.status}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${f.file}</span>
      </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="git-section-desc" style="color:var(--red);">${e.message}</div>`;
  }
}
function doGitCommit() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const repoPath = state.configData.Repos[repo];
  const user = state.configData.DefaultUser || 'the user';
  const mode = document.getElementById('gitCommitBtn').dataset.mode || 'custom';
  if (mode === 'ai') {
    closeGitModal();
    askAi(`In the repo at "${repoPath}", check git status, show me what changed, suggest a commit message, and create the commit. The commit must be signed by "${user}". Run: cd "${repoPath}" && git status`);
    return;
  }

  // Custom commit message
  const title = document.getElementById('gitCommitTitle').value.trim();
  if (!title) {
    toast('Commit title is required', 'info');
    return;
  }
  const body = document.getElementById('gitCommitBody').value.trim();
  const fullMsg = body ? `${title}\n\n${body}` : title;
  closeGitModal();
  // Escape for shell — use the AI to run the commit so it shows in terminal
  const escaped = fullMsg.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  askAi(`In the repo at "${repoPath}", stage all changes and commit with this exact message (do NOT modify it):\n\n${fullMsg}\n\nRun: cd "${repoPath}" && git add -A && git commit -m "${escaped}"`);
}

// ── Project Scripts ──────────────────────────────────────────────────────
async function loadProjectScripts() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  if (!repo) return;
  const bar = document.getElementById('filesScriptsBar');
  const btns = document.getElementById('filesScriptBtns');
  try {
    const res = await fetch(`/api/project/scripts?repo=${encodeURIComponent(repo)}`);
    const data = await res.json();
    if (data.error || !data.scripts) {
      bar.style.display = 'none';
      return;
    }
    const scripts = data.scripts;
    let html = '';

    // Install button if no node_modules
    if (!data.hasNodeModules) {
      html += `<button class="script-btn install" onclick="runNpmScript('install', '${esc(repo)}')">npm install</button>`;
    }

    // Priority scripts first
    const priority = ['dev', 'start', 'build', 'test', 'lint'];
    const shown = new Set();
    for (const key of priority) {
      if (scripts[key]) {
        const isPrimary = key === 'dev' || key === 'start';
        html += `<button class="script-btn ${isPrimary ? 'primary' : ''}" onclick="runNpmScript('${esc(key)}', '${esc(repo)}')">${key}</button>`;
        shown.add(key);
      }
    }

    // Remaining scripts
    const remaining = Object.keys(scripts).filter(k => !shown.has(k));
    if (remaining.length > 0) {
      html += `<select class="script-btn" onchange="if(this.value){runNpmScript(this.value,'${esc(repo)}');this.value=''}" style="padding:3px 6px;">`;
      html += `<option value="">more...</option>`;
      for (const key of remaining) {
        html += `<option value="${esc(key)}">${esc(key)}</option>`;
      }
      html += `</select>`;
    }
    btns.innerHTML = html;
    bar.style.display = html ? '' : 'none';
  } catch (_) {
    bar.style.display = 'none';
  }
}
function runNpmScript(script, repoName) {
  const repoPath = state.configData.Repos[repoName];
  if (!repoPath) return;
  switchTab('terminal');

  // Create a new terminal for the script so it doesn't interrupt the AI
  const termId = addTerminal(`${script}`, repoPath);

  // Wait for PTY to be ready, then run the command
  setTimeout(() => {
    if (script === 'install') {
      sendCommand(`cd "${repoPath}"; npm install`, termId);
    } else {
      sendCommand(`cd "${repoPath}"; npm run ${script}`, termId);
    }
  }, 500);
}

// ── Terminal Panel npm Script Shortcuts ──────────────────────────────────
async function loadTerminalScripts() {
  const repo = state.activeRepo || state.filesCurrentRepo;
  const bar = document.getElementById('termScriptsBar');
  const btns = document.getElementById('termScriptBtns');
  if (!bar || !btns) return;
  if (!repo) {
    bar.style.display = 'none';
    return;
  }
  try {
    const res = await fetch(`/api/project/scripts?repo=${encodeURIComponent(repo)}`);
    const data = await res.json();
    if (data.error || !data.scripts) {
      bar.style.display = 'none';
      return;
    }
    const scripts = data.scripts;
    let html = '';
    const priority = ['dev', 'start', 'build', 'test', 'lint', 'preview'];
    for (const key of priority) {
      if (scripts[key]) {
        const isPrimary = key === 'dev' || key === 'start';
        html += `<button class="script-btn ${isPrimary ? 'primary' : ''}" onclick="runNpmScript('${esc(key)}', '${esc(repo)}')">${key}</button>`;
      }
    }
    btns.innerHTML = html;
    bar.style.display = html ? '' : 'none';
  } catch (_) {
    bar.style.display = 'none';
  }
}

// ── Syntax Highlighting Language Map ─────────────────────────────────────
function hlExtMap(ext) {
  const map = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    less: 'less',
    sass: 'scss',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    psm1: 'powershell',
    psd1: 'powershell',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    r: 'r',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    php: 'php',
    lua: 'lua',
    perl: 'perl',
    pl: 'perl',
    tf: 'hcl',
    hcl: 'hcl',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    csproj: 'xml',
    sln: 'plaintext',
    gitignore: 'plaintext'
  };
  return map[ext] || '';
}

// ── Simple Markdown Parser ──────────────────────────────────────────────
function renderMarkdown(md) {
  if (!md) return '';

  // Step 1: Extract code blocks to protect them
  const codeBlocks = [];
  let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${esc(code.trim())}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // Step 2: Process tables (before other line-level transforms)
  text = text.replace(/^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)*)/gm, (_, headerRow, sepRow, bodyRows) => {
    const headers = headerRow.split('|').filter(c => c.trim());
    // Parse alignment from separator
    const aligns = sepRow.split('|').filter(c => c.trim()).map(c => {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    let html = '<table><thead><tr>';
    headers.forEach((h, i) => {
      html += `<th style="text-align:${aligns[i] || 'left'}">${h.trim()}</th>`;
    });
    html += '</tr></thead><tbody>';
    const rows = bodyRows.trim().split('\n').filter(r => r.trim());
    for (const row of rows) {
      const cells = row.split('|').filter(c => c.trim() !== '' || c.includes(' '));
      // Handle leading/trailing empty from split
      const cleaned = row.replace(/^\||\|$/g, '').split('|');
      html += '<tr>';
      cleaned.forEach((c, i) => {
        html += `<td style="text-align:${aligns[i] || 'left'}">${c.trim()}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  });

  // Step 3: Inline transforms
  let html = text.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^#### (.+)$/gm, '<h4>$1</h4>').replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>').replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>').replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>').replace(/^---+$/gm, '<hr>').replace(/^[\-\*] (.+)$/gm, '<li>$1</li>').replace(/^\d+\. (.+)$/gm, '<li>$1</li>').replace(/^(?!<[hluobdprit\x00]|<\/|<li|<hr|<pre|<block|<img|<a |<strong|<em|<code|<table|<thead|<tbody|<tr|<td|<th)(.+)$/gm, '<p>$1</p>');

  // Wrap lists
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, m => `<ul>${m}</ul>`);
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  html = html.replace(/<\/blockquote>\s*<blockquote>/g, '<br>');

  // Step 4: Restore code blocks
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);
  return html;
}// ── Notes State ─────────────────────────────────────────────────────────
state.currentNote = null;
state.noteMode = 'edit'; // 'edit' or 'preview'
state.noteDirty = false;
async function loadNotesList() {
  try {
    const res = await notesFetch('/api/notes');
    const notes = await res.json();
    window._notesListCache = Array.isArray(notes) ? notes : [];
    const container = document.getElementById('notesList');
    container.innerHTML = notes.map(n => `
      <div class="note-item ${state.currentNote === n.name ? 'active' : ''}" onclick="openNote('${esc(n.name)}')" oncontextmenu="event.preventDefault();showNoteContextMenu(event,'${esc(n.name)}')">
        <span>${esc(n.name)}</span>
      </div>
    `).join('') || '<div style="padding:12px;font-size:11px;color:var(--subtext0);text-align:center;">No notes yet</div>';
  } catch (_) {}
}
async function openNote(name, opts) {
  try {
    markOnboarding('note');
  } catch (_) {}
  try {
    _pushFocus({
      currentNote: name
    });
  } catch (_) {}
  if (state.noteDirty && state.currentNote) await saveCurrentNote();
  try {
    const res = await notesFetch(`/api/notes/read?name=${encodeURIComponent(name)}`);
    const data = await res.json();
    state.currentNote = name;
    state.noteDirty = false;
    document.getElementById('noteTitle').textContent = name;
    const ta = document.getElementById('noteTextarea');
    ta.value = data.content || '';
    document.getElementById('noteEmpty').style.display = 'none';
    document.getElementById('noteSaveBtn').style.display = 'none';
    // If a search query was passed, jump to the first match in edit mode so
    // the user can see WHERE the term occurs (instead of just opening the
    // note at the top).
    const term = opts && opts.jumpTo ? String(opts.jumpTo).toLowerCase() : null;
    if (term) {
      setNoteMode('edit');
      const idx = ta.value.toLowerCase().indexOf(term);
      if (idx !== -1) {
        // Use a 0-length selection at idx so all matches stay reachable via Ctrl+F.
        // Then trigger note-find with this term so the highlight bar opens too.
        ta.focus();
        ta.setSelectionRange(idx, idx + term.length);
        // Approximate scroll to the line containing the match
        const before = ta.value.substring(0, idx);
        const lines = before.split('\n').length;
        const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24;
        ta.scrollTop = Math.max(0, lines * lineHeight - ta.clientHeight / 2);
        // Also open the note find bar with this term pre-filled
        openNoteFind(term);
      }
    } else {
      setNoteMode('preview');
    }
    loadNotesList();
  } catch (_) {}
}
function setNoteMode(mode) {
  state.noteMode = mode;
  const editor = document.getElementById('noteEditor');
  const preview = document.getElementById('notePreview');
  const btn = document.getElementById('noteModeBtn');
  if (mode === 'edit') {
    editor.style.display = 'flex';
    preview.style.display = 'none';
    btn.textContent = 'Preview';
  } else {
    editor.style.display = 'none';
    preview.style.display = 'block';
    preview.innerHTML = renderMarkdown(document.getElementById('noteTextarea').value);
    preview.querySelectorAll('pre code[class*="language-"]').forEach(el => {
      try {
        hljs.highlightElement(el);
      } catch (_) {}
    });
    btn.textContent = 'Edit';
  }
}
function toggleNoteMode() {
  if (!state.currentNote) return;
  setNoteMode(state.noteMode === 'edit' ? 'preview' : 'edit');
}
function onNoteInput() {
  state.noteDirty = true;
  document.getElementById('noteSaveBtn').style.display = '';
  _maybeOpenNoteSlashMenu();
  _maybeOpenNoteMentionMenu();
}

// ── Note slash menu: typing "/" at the start of a line opens a quick menu
// of AI actions that run on the current note content. Close with Escape or
// any non-slash keypress. Inspired by agent-native's ComposeSlashMenu.
const NOTE_SLASH_ACTIONS = [{
  key: 'summarize',
  label: 'Summarize this note',
  icon: 'list',
  build: text => 'Summarize this note in 5 bullets. Keep it tight.\n\n---\n' + text
}, {
  key: 'rewrite',
  label: 'Rewrite cleanly',
  icon: 'wand-2',
  build: text => 'Rewrite the following note so it reads clearly and professionally. Preserve the meaning, fix grammar, keep the same length.\n\n---\n' + text
}, {
  key: 'todos',
  label: 'Extract action items',
  icon: 'check-square',
  build: text => 'Extract every action item from this note as a markdown checklist. Use concrete verbs.\n\n---\n' + text
}, {
  key: 'email',
  label: 'Turn into an email',
  icon: 'mail',
  build: text => 'Turn this note into a polite, concise email. Suggest a subject line. Keep it under 200 words.\n\n---\n' + text
}, {
  key: 'expand',
  label: 'Expand with details',
  icon: 'maximize-2',
  build: text => 'Expand this note with sensible detail, examples, and structure. Preserve my voice.\n\n---\n' + text
}, {
  key: 'translate-fr',
  label: 'Translate to French',
  icon: 'languages',
  build: text => 'Translate this note into natural, idiomatic French. Preserve formatting.\n\n---\n' + text
}];
function _maybeOpenNoteSlashMenu() {
  const ta = document.getElementById('noteTextarea');
  if (!ta) return;
  const caret = ta.selectionStart;
  if (caret == null) return;
  const v = ta.value;
  // Look backwards for the start of the current line.
  const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
  const lineSoFar = v.slice(lineStart, caret);
  // Only fire when the line starts with "/" and has no spaces - keep the
  // menu pattern predictable instead of surprising.
  if (lineSoFar === '/' || /^\/[a-zA-Z-]*$/.test(lineSoFar)) {
    _openNoteSlashMenu(lineSoFar, lineStart);
  } else {
    _closeNoteSlashMenu();
  }
}
function _openNoteSlashMenu(lineSoFar, lineStart) {
  let menu = document.getElementById('noteSlashMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'noteSlashMenu';
    menu.className = 'note-slash-menu';
    document.body.appendChild(menu);
  }
  const query = lineSoFar.slice(1).toLowerCase();
  const matches = NOTE_SLASH_ACTIONS.filter(a => !query || a.key.startsWith(query) || a.label.toLowerCase().includes(query));
  if (!matches.length) {
    _closeNoteSlashMenu();
    return;
  }
  menu.innerHTML = matches.map((a, i) => '<div class="note-slash-item' + (i === 0 ? ' active' : '') + '" data-key="' + a.key + '">' + '<i data-lucide="' + a.icon + '" style="width:13px;height:13px;"></i>' + '<span>' + esc(a.label) + '</span>' + '<span class="note-slash-hint">/' + a.key + '</span>' + '</div>').join('');
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
  // Anchor under the textarea. We don't compute caret coordinates - pinning
  // to the editor's top-left corner is predictable and avoids line-wrap math.
  const ta = document.getElementById('noteTextarea');
  const r = ta.getBoundingClientRect();
  menu.style.top = r.top + 10 + 'px';
  menu.style.left = r.left + 24 + 'px';
  menu.style.display = 'block';
  menu.dataset.lineStart = String(lineStart);
  menu.querySelectorAll('.note-slash-item').forEach(el => {
    el.addEventListener('mousedown', ev => {
      ev.preventDefault();
      _runNoteSlashAction(el.dataset.key, parseInt(menu.dataset.lineStart, 10));
    });
  });
}
function _closeNoteSlashMenu() {
  const m = document.getElementById('noteSlashMenu');
  if (m) m.style.display = 'none';
}
function _runNoteSlashAction(key, lineStart) {
  const action = NOTE_SLASH_ACTIONS.find(a => a.key === key);
  const ta = document.getElementById('noteTextarea');
  if (!action || !ta) return;
  // Remove the slash trigger from the textarea (everything from lineStart to caret).
  const caret = ta.selectionStart;
  const before = ta.value.slice(0, lineStart);
  const after = ta.value.slice(caret);
  ta.value = before + after;
  ta.selectionStart = ta.selectionEnd = lineStart;
  _closeNoteSlashMenu();
  const content = ta.value.trim();
  if (!content) {
    toast('Note is empty - nothing to act on', 'warning');
    return;
  }
  askAIFromPalette(action.build(content));
}

// Arrow-key + Enter support for the slash menu.
document.addEventListener('keydown', e => {
  const menu = document.getElementById('noteSlashMenu');
  if (!menu || menu.style.display === 'none') return;
  if (document.activeElement?.id !== 'noteTextarea') return;
  const items = menu.querySelectorAll('.note-slash-item');
  if (!items.length) return;
  let idx = Array.from(items).findIndex(el => el.classList.contains('active'));
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = (idx + 1) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = (idx - 1 + items.length) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const active = items[idx] || items[0];
    _runNoteSlashAction(active.dataset.key, parseInt(menu.dataset.lineStart, 10));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    _closeNoteSlashMenu();
  }
}, true);

// ── Note @-mentions: link to another note or repo ────────────────────────
// Typing "@" pops a grouped picker. Selecting an item inserts a markdown
// reference like "[Note: my-note](note:my-note)". The AI can treat these
// as explicit cross-document pointers without needing fuzzy matching.
function _gatherMentionCandidates() {
  const out = {
    notes: [],
    repos: []
  };
  try {
    if (Array.isArray(window._notesListCache)) {
      out.notes = window._notesListCache.slice(0, 30).map(n => ({
        key: 'note:' + n.name,
        label: n.name,
        category: 'Notes',
        icon: 'file-text',
        insert: '[Note: ' + n.name + '](note:' + encodeURIComponent(n.name) + ')'
      }));
    }
  } catch (_) {}
  try {
    if (state.configData && state.configData.Repos) {
      out.repos = Object.keys(state.configData.Repos).slice(0, 20).map(name => ({
        key: 'repo:' + name,
        label: name,
        category: 'Repos',
        icon: 'git-branch',
        insert: '[Repo: ' + name + '](repo:' + encodeURIComponent(name) + ')'
      }));
    }
  } catch (_) {}
  return [...out.notes, ...out.repos];
}
function _maybeOpenNoteMentionMenu() {
  const ta = document.getElementById('noteTextarea');
  if (!ta) return;
  const caret = ta.selectionStart;
  if (caret == null) return;
  const v = ta.value;
  // Look back for the nearest "@" that starts the current mention token.
  let start = caret - 1;
  while (start >= 0 && v[start] !== '@' && v[start] !== '\n' && v[start] !== ' ' && v[start] !== '\t') start--;
  if (start < 0 || v[start] !== '@') {
    _closeNoteMentionMenu();
    return;
  }
  const token = v.slice(start + 1, caret);
  if (/\s/.test(token)) {
    _closeNoteMentionMenu();
    return;
  }
  _openNoteMentionMenu(token.toLowerCase(), start);
}
function _openNoteMentionMenu(q, atIndex) {
  const candidates = _gatherMentionCandidates();
  const matches = q ? candidates.filter(c => c.label.toLowerCase().includes(q)) : candidates;
  if (!matches.length) {
    _closeNoteMentionMenu();
    return;
  }
  let menu = document.getElementById('noteMentionMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'noteMentionMenu';
    menu.className = 'note-slash-menu';
    document.body.appendChild(menu);
  }
  // Group by category, preserve first 10 per group.
  const groups = {};
  for (const m of matches) {
    (groups[m.category] = groups[m.category] || []).push(m);
  }
  let first = null;
  const html = Object.keys(groups).map(cat => {
    const rows = groups[cat].slice(0, 10).map(m => {
      if (!first) first = m;
      return '<div class="note-slash-item" data-mkey="' + esc(m.key) + '">' + '<i data-lucide="' + esc(m.icon) + '" style="width:13px;height:13px;"></i>' + '<span>' + esc(m.label) + '</span>' + '<span class="note-slash-hint">' + esc(cat) + '</span>' + '</div>';
    }).join('');
    return rows;
  }).join('');
  menu.innerHTML = html;
  menu.querySelectorAll('.note-slash-item').forEach((el, i) => {
    if (i === 0) el.classList.add('active');
    el.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const key = el.dataset.mkey;
      const m = matches.find(x => x.key === key);
      if (m) _insertNoteMention(m, atIndex);
    });
  });
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
  const ta = document.getElementById('noteTextarea');
  const r = ta.getBoundingClientRect();
  menu.style.top = r.top + 10 + 'px';
  menu.style.left = r.left + 24 + 'px';
  menu.style.display = 'block';
  menu.dataset.atIndex = String(atIndex);
}
function _closeNoteMentionMenu() {
  const m = document.getElementById('noteMentionMenu');
  if (m) m.style.display = 'none';
}
function _insertNoteMention(match, atIndex) {
  const ta = document.getElementById('noteTextarea');
  if (!ta) return;
  const caret = ta.selectionStart;
  const before = ta.value.slice(0, atIndex);
  const after = ta.value.slice(caret);
  const inserted = match.insert + ' ';
  ta.value = before + inserted + after;
  const pos = before.length + inserted.length;
  ta.selectionStart = ta.selectionEnd = pos;
  _closeNoteMentionMenu();
  onNoteInput(); // mark dirty + update highlights
}

// Arrow/Enter/Escape handling for the mention menu.
document.addEventListener('keydown', e => {
  const menu = document.getElementById('noteMentionMenu');
  if (!menu || menu.style.display === 'none') return;
  if (document.activeElement?.id !== 'noteTextarea') return;
  const items = menu.querySelectorAll('.note-slash-item');
  if (!items.length) return;
  let idx = Array.from(items).findIndex(el => el.classList.contains('active'));
  if (idx < 0) idx = 0;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    idx = (idx + 1) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    idx = (idx - 1 + items.length) % items.length;
    items.forEach(i => i.classList.remove('active'));
    items[idx].classList.add('active');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const active = items[idx] || items[0];
    const key = active.dataset.mkey;
    const all = _gatherMentionCandidates();
    const match = all.find(x => x.key === key);
    if (match) _insertNoteMention(match, parseInt(menu.dataset.atIndex, 10));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    _closeNoteMentionMenu();
  }
}, true);
async function saveCurrentNote() {
  if (!state.currentNote) return;
  const content = document.getElementById('noteTextarea').value;
  try {
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: state.currentNote,
        content
      })
    });
    state.noteDirty = false;
    document.getElementById('noteSaveBtn').style.display = 'none';
    toast('Note saved', 'success');
  } catch (_) {
    toast('Failed to save', 'error');
  }
}
function showNewNoteInput() {
  const wrap = document.getElementById('newNoteInputWrap');
  const input = document.getElementById('newNoteInput');
  wrap.style.display = '';
  input.value = '';
  input.focus();
}
function hideNewNoteInput() {
  document.getElementById('newNoteInputWrap').style.display = 'none';
}
async function confirmCreateNote() {
  const input = document.getElementById('newNoteInput');
  const name = input.value.trim();
  if (!name) return;
  try {
    const res = await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name
      })
    });
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    hideNewNoteInput();
    await loadNotesList();
    openNote(data.name);
  } catch (_) {}
}
async function deleteNote(name) {
  const ok = await customConfirm('Delete Note', `Delete "${name}"? This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    await notesFetch('/api/notes/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name
      })
    });
    if (state.currentNote === name) {
      state.currentNote = null;
      document.getElementById('noteTitle').textContent = 'No note selected';
      document.getElementById('noteEditor').style.display = 'none';
      document.getElementById('notePreview').style.display = 'none';
      document.getElementById('noteEmpty').style.display = '';
    }
    loadNotesList();
  } catch (_) {}
}
function sendNoteToAi() {
  if (!state.currentNote) return;
  const content = document.getElementById('noteTextarea').value;
  if (!content.trim()) {
    toast('Note is empty', 'info');
    return;
  }
  const name = state.currentNote;
  askAi(`Fetch the Symphonee note named "${name}" via GET /api/notes/read?name=${encodeURIComponent(name)}&ns=${encodeURIComponent(currentNotesNs())} and use its content as context for our conversation. I may ask you to expand on it, update it, or take action based on it.`);
}
function exportCurrentNote() {
  if (!state.currentNote) {
    toast('No note selected', 'info');
    return;
  }
  const a = document.createElement('a');
  a.href = '/api/notes/export?name=' + encodeURIComponent(state.currentNote) + '&ns=' + encodeURIComponent(currentNotesNs());
  a.download = state.currentNote + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function exportAllNotes() {
  const a = document.createElement('a');
  a.href = '/api/notes/export-all';
  a.download = 'symphonee-notes.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function importNotesFromFile() {
  document.getElementById('notesImportFile').click();
}
async function onNotesImportFileChosen(ev) {
  const files = Array.from(ev.target.files || []);
  ev.target.value = '';
  if (!files.length) return;
  const notes = {};
  for (const f of files) {
    const text = await f.text();
    if (f.name.endsWith('.json')) {
      try {
        const parsed = JSON.parse(text);
        const src = parsed && parsed.notes && typeof parsed.notes === 'object' ? parsed.notes : typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        if (src) for (const [k, v] of Object.entries(src)) if (typeof v === 'string') notes[k] = v;
      } catch (_) {
        toast('Invalid JSON: ' + f.name, 'error');
      }
    } else if (f.name.endsWith('.md')) {
      notes[f.name.replace(/\.md$/i, '')] = text;
    }
  }
  if (!Object.keys(notes).length) {
    toast('No notes to import', 'info');
    return;
  }
  try {
    const r = await notesFetch('/api/notes/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        notes
      })
    });
    const d = await r.json();
    if (d.ok) {
      toast('Imported ' + d.written + ' note(s)' + (d.skipped ? ', ' + d.skipped + ' skipped' : ''), 'success');
      loadNotes();
    } else toast(d.error || 'Import failed', 'error');
  } catch (e) {
    toast('Import failed: ' + e.message, 'error');
  }
}

// ── Custom Confirm / Prompt Dialogs ─────────────────────────────────────
state.confirmResolve = null;
state.promptResolve = null;
function customConfirm(title, message, okLabel = 'Confirm') {
  return new Promise(resolve => {
    state.confirmResolve = resolve;
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmOkBtn').textContent = okLabel;
    document.getElementById('confirmDialog').classList.add('open');
  });
}
function closeConfirm(result) {
  document.getElementById('confirmDialog').classList.remove('open');
  if (state.confirmResolve) {
    state.confirmResolve(result);
    state.confirmResolve = null;
  }
}
function customPrompt(title, defaultValue = '') {
  return new Promise(resolve => {
    state.promptResolve = resolve;
    document.getElementById('promptTitle').textContent = title;
    const input = document.getElementById('promptInput');
    input.value = defaultValue;
    document.getElementById('promptDialog').classList.add('open');
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  });
}
function closePrompt(ok) {
  document.getElementById('promptDialog').classList.remove('open');
  if (state.promptResolve) {
    state.promptResolve(ok ? document.getElementById('promptInput').value.trim() : null);
    state.promptResolve = null;
  }
}

// ── Note Context Menu ───────────────────────────────────────────────────
state.contextNoteName = null;
function showNoteContextMenu(e, name) {
  state.contextNoteName = name;
  const menu = document.getElementById('noteContextMenu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('open');
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
}
document.addEventListener('click', () => {
  document.getElementById('noteContextMenu').classList.remove('open');
  document.getElementById('diffFileContextMenu').classList.remove('open');
  const ftc = document.getElementById('fileTreeContextMenu');
  if (ftc) ftc.classList.remove('open');
});

// ── File tree context menu (Open in Explorer) ───────────────────────────
state.contextFileTreePath = null;
function showFileTreeContextMenu(e, filePath) {
  state.contextFileTreePath = filePath;
  const menu = document.getElementById('fileTreeContextMenu');
  if (!menu) return;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.add('open');
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
}
async function revealPath(type, payload) {
  try {
    const res = await fetch('/api/ui/reveal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(Object.assign({
        type
      }, payload))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      toast(data.error || 'Could not reveal', 'error');
      return false;
    }
    return true;
  } catch (_) {
    toast('Could not reveal', 'error');
    return false;
  }
}
async function revealFileFromContext() {
  document.getElementById('fileTreeContextMenu').classList.remove('open');
  if (!state.filesCurrentRepo || !state.contextFileTreePath) return;
  await revealPath('file', {
    repo: state.filesCurrentRepo,
    path: state.contextFileTreePath
  });
}
async function revealCurrentFileInExplorer() {
  if (!state.filesCurrentRepo || !state.filesCurrentFile) return;
  await revealPath('file', {
    repo: state.filesCurrentRepo,
    path: state.filesCurrentFile.path
  });
}
async function revealCurrentNoteInExplorer() {
  if (!state.currentNote) {
    toast('Select a note first', 'error');
    return;
  }
  await revealPath('note', {
    name: state.currentNote
  });
}
async function revealNoteFromContext() {
  document.getElementById('noteContextMenu').classList.remove('open');
  if (!state.contextNoteName) return;
  await revealPath('note', {
    name: state.contextNoteName
  });
}
async function deleteNoteFromContext() {
  document.getElementById('noteContextMenu').classList.remove('open');
  if (!state.contextNoteName) return;
  const ok = await customConfirm('Delete Note', `Delete "${state.contextNoteName}"? This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    await notesFetch('/api/notes/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: state.contextNoteName
      })
    });
    if (state.currentNote === state.contextNoteName) {
      state.currentNote = null;
      document.getElementById('noteTitle').textContent = 'No note selected';
      document.getElementById('noteEditor').style.display = 'none';
      document.getElementById('notePreview').style.display = 'none';
      document.getElementById('noteEmpty').style.display = '';
    }
    loadNotesList();
  } catch (_) {}
}
async function renameNoteFromContext() {
  document.getElementById('noteContextMenu').classList.remove('open');
  if (!state.contextNoteName) return;
  const newName = await customPrompt('Rename Note', state.contextNoteName);
  if (!newName || newName === state.contextNoteName) return;
  try {
    // Read old, create new, delete old
    const res = await notesFetch(`/api/notes/read?name=${encodeURIComponent(state.contextNoteName)}`);
    const data = await res.json();
    await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newName
      })
    });
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newName,
        content: data.content
      })
    });
    await notesFetch('/api/notes/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: state.contextNoteName
      })
    });
    if (state.currentNote === state.contextNoteName) state.currentNote = newName;
    loadNotesList();
    if (state.currentNote === newName) document.getElementById('noteTitle').textContent = newName;
  } catch (_) {
    toast('Failed to rename', 'error');
  }
}
async function duplicateNoteFromContext() {
  document.getElementById('noteContextMenu').classList.remove('open');
  if (!state.contextNoteName) return;
  const newName = await customPrompt('Duplicate Note', state.contextNoteName + ' (copy)');
  if (!newName) return;
  try {
    const res = await notesFetch(`/api/notes/read?name=${encodeURIComponent(state.contextNoteName)}`);
    const data = await res.json();
    await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newName
      })
    });
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: newName,
        content: data.content
      })
    });
    loadNotesList();
    toast(`Duplicated as "${newName}"`, 'success');
  } catch (_) {
    toast('Failed to duplicate', 'error');
  }
}// ── Orchestrator ────────────────────────────────────────────────────────
state.orchTasks = [];
state.orchAgents = [];
async function orchRefresh() {
  // Sync the scope filter default to the current space before fetching so the
  // first render already reflects "this space" when a space is active.
  try {
    syncOrchScopeFilter();
  } catch (_) {}
  await Promise.all([orchRefreshAgents(), orchRefreshTasks()]);
}

// Keep the orchestrator scope <select> default aligned with the active space.
// When a space is active, default to 'space'; otherwise 'all'. Preserves the
// user's choice within a session (only overrides if the current value is no
// longer sensible - e.g. they had 'space' selected and then cleared the space).
function syncOrchScopeFilter() {
  const el = document.getElementById('orchScopeFilter');
  if (!el) return;
  if (!state.activeSpace && el.value === 'space') el.value = 'all';else if (state.activeSpace && !el.dataset.userTouched) el.value = 'space';
}
async function orchRefreshAgents() {
  try {
    const agents = await fetch('/api/orchestrator/agents').then(r => r.json());
    state.orchAgents = agents;
    renderOrchAgents();
  } catch (_) {}
}
async function orchRefreshTasks() {
  try {
    const filter = document.getElementById('orchTaskFilter')?.value || '';
    const scopeEl = document.getElementById('orchScopeFilter');
    const scope = scopeEl ? scopeEl.value : '';
    const params = [];
    if (filter) params.push('state=' + encodeURIComponent(filter));
    // scope: '' or 'all' = unfiltered; 'space' = only tasks tagged with the
    // currently active space.
    if (scope === 'space' && state.activeSpace) params.push('space=' + encodeURIComponent(state.activeSpace));
    const url = '/api/orchestrator/tasks' + (params.length ? '?' + params.join('&') : '');
    const tasks = await fetch(url).then(r => r.json());
    state.orchTasks = tasks;
    renderOrchTasks();
  } catch (_) {}
}
function renderOrchAgents() {
  const el = document.getElementById('orchAgentList');
  if (!el) return;
  var items = [];
  // 1. Real terminals with an AI launched (the supervisor and any visible spawns)
  state.orchAgents.forEach(function (a) {
    var aiState = typeof termAiState !== 'undefined' ? termAiState.get(a.termId) : null;
    if (!aiState || !aiState.launched) return;
    var cli = aiState.cli || null;
    var label = CLI_CONFIG[cli]?.label || cli || 'AI';
    var busyTask = state.orchTasks.find(function (t) {
      return t.state === 'running' && (t.targetTermId === a.termId || t.from === a.termId);
    });
    items.push('<div class="orch-agent" onclick="orchSelectAgent(\'' + a.termId + '\')">' + '<div class="orch-agent-dot ' + (busyTask ? 'busy' : 'ai') + '"></div>' + '<div class="orch-agent-info">' + '<div class="orch-agent-name">' + label + '</div>' + '<div class="orch-agent-sub">' + a.termId + (busyTask ? ' - orchestrating' : '') + '</div>' + '</div></div>');
  });
  // 2. Headless spawns that are currently running (these have no terminal entry)
  state.orchTasks.forEach(function (t) {
    if (t.state !== 'running' || t.type !== 'headless' || !t.cli) return;
    var label = CLI_CONFIG[t.cli]?.label || t.cli;
    var modelSuffix = t.model ? ' <span style="font-size:10px;color:var(--overlay1);font-weight:400;">' + t.model + '</span>' : '';
    var title = (t.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim().split(/[.\n]/)[0].substring(0, 60);
    items.push('<div class="orch-agent">' + '<div class="orch-agent-dot busy"></div>' + '<div class="orch-agent-info">' + '<div class="orch-agent-name">' + label + modelSuffix + '</div>' + '<div class="orch-agent-sub">' + (title || t.id) + '</div>' + '</div></div>');
  });
  if (!items.length) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--overlay0);font-size:11px;">No AI agents running</div>';
    return;
  }
  el.innerHTML = items.join('');
}
state._orchTimerInterval = null;
function formatOrchDuration(ms) {
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + s % 60 + 's';
}

// Live output buffer per task (captured from headless stdout via server broadcast)
const _orchTaskOutput = new Map(); // taskId -> string

function renderOrchTasks() {
  const el = document.getElementById('orchTaskList');
  const emptyEl = document.getElementById('orchEmptyState');
  const countEl = document.getElementById('orchTaskCount');
  if (!el) return;

  // Client-side filter: free-text matches across prompt / cli / model / state.
  const q = (document.getElementById('orchTaskSearch')?.value || '').trim().toLowerCase();
  const tasksAll = state.orchTasks;
  const visibleTasks = q ? tasksAll.filter(t => {
    const parts = [t.prompt, t.cli, t.model, t.state, t.type, t.from].filter(Boolean).join(' ').toLowerCase();
    return parts.includes(q);
  }) : tasksAll;
  if (countEl) {
    countEl.textContent = q ? visibleTasks.length + ' of ' + tasksAll.length : tasksAll.length + ' task' + (tasksAll.length === 1 ? '' : 's');
  }
  if (!visibleTasks.length) {
    el.innerHTML = '';
    if (q) {
      el.innerHTML = '<div style="padding:24px 12px;text-align:center;color:var(--subtext0);font-size:12px;">No tasks match "' + esc(q) + '"</div>';
      if (state._orchTimerInterval) {
        clearInterval(state._orchTimerInterval);
        state._orchTimerInterval = null;
      }
      return;
    }
    if (emptyEl) {
      emptyEl.style.display = '';
      el.appendChild(emptyEl);
    }
    if (state._orchTimerInterval) {
      clearInterval(state._orchTimerInterval);
      state._orchTimerInterval = null;
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // Preserve expanded state (running tasks default to expanded)
  const expandedIds = new Set();
  el.querySelectorAll('.orch-task.expanded').forEach(e => expandedIds.add(e.dataset.id));
  // Preserve accordion open/closed state per task: { taskId: { 'Prompt': true, 'Result': false, ... } }
  const accordionState = {};
  el.querySelectorAll('.orch-task').forEach(function (taskEl) {
    var id = taskEl.dataset.id;
    if (!id) return;
    var acc = {};
    taskEl.querySelectorAll('.orch-accordion').forEach(function (a) {
      var label = a.querySelector('.orch-accordion-head')?.textContent?.trim() || '';
      if (label) acc[label] = a.classList.contains('open');
    });
    if (Object.keys(acc).length) accordionState[id] = acc;
  });

  // Build parent/child index for threading. A task with parentTaskId whose parent
  // is in the visible set is nested; otherwise it's rendered at the top level.
  const visibleById = new Map();
  visibleTasks.forEach(t => visibleById.set(t.id, t));
  const childrenOf = new Map();
  const rootTasks = [];
  visibleTasks.forEach(t => {
    const pid = t.parentTaskId;
    if (pid && visibleById.has(pid)) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(t);
    } else {
      rootTasks.push(t);
    }
  });
  // Stable-sort children by creation time (ascending) so conversation reads top-down.
  childrenOf.forEach(list => list.sort((a, b) => (a.createdAt || a.startedAt || 0) - (b.createdAt || b.startedAt || 0)));
  function countThreadDescendants(id) {
    const kids = childrenOf.get(id) || [];
    return kids.reduce((acc, k) => acc + 1 + countThreadDescendants(k.id), 0);
  }
  function renderTaskCard(t, depth) {
    const isRunning = t.state === 'running';
    const isPending = t.state === 'pending';
    const elapsed = t.completedAt ? formatOrchDuration(t.completedAt - t.startedAt) : t.startedAt ? formatOrchDuration(Date.now() - t.startedAt) : '--';
    const cliLabel = t.cli ? CLI_CONFIG[t.cli]?.label || t.cli : t.type;
    const modelLabel = t.model ? '<span style="font-size:10px;color:var(--overlay1);font-weight:400;margin-left:4px;">' + String(t.model).replace(/</g, '&lt;') + '</span>' : '';
    const fromLabel = t.from ? 'from ' + t.from : '';
    const promptRaw = (t.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim();
    const promptFull = promptRaw.replace(/</g, '&lt;');
    // Extract a short title from the first sentence/line of the prompt
    const titleRaw = promptRaw.split(/[.\n]/)[0].substring(0, 80);
    const taskTitle = titleRaw.replace(/</g, '&lt;') || 'Task';
    const liveOutput = _orchTaskOutput.get(t.id) || '';
    // Helper: check saved accordion state, fallback to default
    const saved = accordionState[t.id] || {};
    const accOpen = function (label, defaultOpen) {
      return (saved[label] !== undefined ? saved[label] : defaultOpen) ? ' open' : '';
    };
    const accHead = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    const resultBlock = t.result ? '<div class="orch-task-result orch-task-md">' + renderMarkdown(t.result) + '</div>' : '';
    const errorBlock = t.error ? '<div class="orch-task-result" style="color:var(--red);">' + t.error.replace(/</g, '&lt;') + '</div>' : '';
    const outputBlock = isRunning && liveOutput ? '<div class="orch-accordion' + accOpen('Live Output', true) + '" onclick="event.stopPropagation();this.classList.toggle(\'open\')"><div class="orch-accordion-head">' + accHead + 'Live Output</div><div class="orch-accordion-body"><div class="orch-task-output" data-output-id="' + t.id + '">' + liveOutput.substring(liveOutput.length - 2000).replace(/</g, '&lt;') + '</div></div></div>' : '';
    // Running/pending tasks expanded by default, others respect user toggle
    const expanded = isRunning || expandedIds.has(t.id) ? ' expanded' : '';

    // Action buttons for visible spawns
    const viewBtn = t.type === 'visible' && t.targetTermId ? '<button class="orch-task-btn view" onclick="event.stopPropagation();orchSelectAgent(\'' + t.targetTermId + '\')">View Terminal</button>' : '';

    // Current step: last non-empty line of the streaming output, trimmed.
    // Pulled live via the websocket feed the same way Live Output is.
    let currentStep = '';
    if (isRunning && liveOutput) {
      const lines = liveOutput.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length) currentStep = lines[lines.length - 1].slice(0, 120);
    }
    const stepLine = currentStep ? '<div class="orch-task-step" data-step-id="' + t.id + '" title="' + currentStep.replace(/"/g, '&quot;') + '">' + currentStep.replace(/</g, '&lt;') + '</div>' : isRunning ? '<div class="orch-task-step" data-step-id="' + t.id + '">Working...</div>' : '';
    const descendantCount = countThreadDescendants(t.id);
    const threadChip = descendantCount ? '<span class="orch-task-thread-count" title="Thread depth">+' + descendantCount + ' repl' + (descendantCount === 1 ? 'y' : 'ies') + '</span>' : '';
    const isReply = t.parentTaskId ? true : false;
    const replyChip = isReply ? '<span class="orch-task-thread-chip" title="Reply to ' + String(t.parentTaskId).slice(0, 8) + '">reply</span>' : '';
    const replyComposer = !isRunning && !isPending ? '<div class="orch-task-reply" onclick="event.stopPropagation()">' + '<div class="orch-task-reply-label">Reply inline</div>' + '<textarea id="inlineReply_' + t.id + '" placeholder="Continue the conversation..." onkeydown="if(event.key===\'Enter\'&&(event.metaKey||event.ctrlKey)){event.preventDefault();_inlineReplySend(\'' + t.id + '\');}"></textarea>' + '<div class="orch-task-reply-actions">' + '<span class="orch-task-reply-hint">Ctrl/Cmd+Enter to send - spawns a follow-up task with the prior Q/A as context</span>' + '<button class="orch-task-reply-send" id="inlineReplySend_' + t.id + '" onclick="_inlineReplySend(\'' + t.id + '\')">Send reply</button>' + '</div>' + '</div>' : '';
    const cardHtml = '<div class="orch-task ' + t.state + expanded + '" data-id="' + t.id + '" data-depth="' + depth + '" onclick="orchToggleTask(this)">' + '<div class="orch-task-header">' + '<div class="orch-task-left">' + '<div class="orch-task-left-top">' + '<span class="cli-name">' + cliLabel + '</span>' + modelLabel + (fromLabel ? '<span>' + fromLabel + '</span>' : '') + replyChip + threadChip + '</div>' + '<div style="font-size:12px;color:var(--text);font-weight:500;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:500px;">' + taskTitle + '</div>' + stepLine + '<div class="orch-task-left-bottom">' + t.type + ' / ' + t.id + '</div>' + (isRunning ? '<div class="orch-watcher-status" style="font-size:10px;color:var(--yellow);font-family:var(--font-mono);margin-top:2px;display:none;"></div>' : '') + '</div>' + '<div class="orch-task-right">' + '<span class="orch-task-state ' + t.state + '">' + t.state + '</span>' + '<span class="orch-task-timer' + (isRunning ? ' live' : '') + '" data-started="' + (t.startedAt || '') + '">' + elapsed + '</span>' + '</div>' + '</div>' + '<div class="orch-task-expand">' + '<div class="orch-accordion' + accOpen('Prompt', false) + '" onclick="event.stopPropagation();this.classList.toggle(\'open\')"><div class="orch-accordion-head">' + accHead + 'Prompt</div><div class="orch-accordion-body"><div class="orch-task-prompt">' + promptFull + '</div></div></div>' + outputBlock + (resultBlock ? '<div class="orch-accordion' + accOpen('Result', true) + '" onclick="event.stopPropagation();this.classList.toggle(\'open\')"><div class="orch-accordion-head">' + accHead + 'Result</div><div class="orch-accordion-body">' + resultBlock + '</div></div>' : '') + (errorBlock ? '<div class="orch-accordion' + accOpen('Error', true) + '" onclick="event.stopPropagation();this.classList.toggle(\'open\')"><div class="orch-accordion-head">' + accHead + 'Error</div><div class="orch-accordion-body">' + errorBlock + '</div></div>' : '') + ('<div class="orch-task-actions-row">' + viewBtn + (isRunning ? '<button class="orch-task-btn cancel" onclick="event.stopPropagation();orchCancelTask(\'' + t.id + '\')">Cancel</button>' : '<button class="orch-task-btn" onclick="event.stopPropagation();_focusInlineReply(\'' + t.id + '\')" title="Jump to the reply box below">Reply</button>' + '<button class="orch-task-btn" onclick="event.stopPropagation();orchShareTask(\'' + t.id + '\')" title="Copy this task as markdown">Share</button>' + '<button class="orch-task-btn cancel" onclick="event.stopPropagation();orchDeleteTask(\'' + t.id + '\')">Delete</button>') + '</div>') + replyComposer + '</div>' + '</div>';
    const kids = childrenOf.get(t.id) || [];
    const kidsHtml = kids.map(k => renderTaskCard(k, depth + 1)).join('');
    return cardHtml + kidsHtml;
  }
  el.innerHTML = rootTasks.map(t => renderTaskCard(t, 0)).join('');

  // Pin each live-output pane to the bottom after a re-render. Without this,
  // the 5-second auto-refresh recreates the DOM and scroll resets to top.
  document.querySelectorAll('.orch-task-output').forEach(function (out) {
    out.scrollTop = out.scrollHeight;
  });

  // Start/stop live timer for running tasks
  const hasRunning = state.orchTasks.some(t => t.state === 'running');
  if (hasRunning && !state._orchTimerInterval) {
    state._orchTimerInterval = setInterval(updateOrchTimers, 1000);
  } else if (!hasRunning && state._orchTimerInterval) {
    clearInterval(state._orchTimerInterval);
    state._orchTimerInterval = null;
  }
}
state._orchRefreshCounter = 0;
function updateOrchTimers() {
  document.querySelectorAll('.orch-task-timer.live').forEach(el => {
    const started = parseInt(el.dataset.started);
    if (started) el.textContent = formatOrchDuration(Date.now() - started);
  });
  // Auto-refresh task data every 5 seconds as a safety net
  // (WebSocket events should handle most updates, but this catches missed ones)
  state._orchRefreshCounter++;
  if (state._orchRefreshCounter % 5 === 0) orchRefreshTasks();
}
function orchToggleTask(el) {
  el.classList.toggle('expanded');
}
function orchSelectAgent(termId) {
  switchTab('terminal');
  if (typeof switchTerminal === 'function') switchTerminal(termId);
}
async function orchCancelTask(taskId) {
  await fetch('/api/orchestrator/cancel', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      taskId
    })
  });
  orchRefreshTasks();
}
async function orchDeleteTask(taskId) {
  await fetch('/api/orchestrator/task', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      taskId
    })
  });
  _orchTaskOutput.delete(taskId);
  orchRefreshTasks();
}

// Copy a completed task as clean markdown: prompt + result + metadata. Gives
// the user a one-click share surface without standing up a real share server.
async function orchShareTask(taskId) {
  const t = state.orchTasks.find(x => x.id === taskId);
  if (!t) {
    toast('Task not found', 'error');
    return;
  }
  const cliLabel = t.cli ? CLI_CONFIG[t.cli]?.label || t.cli : t.type;
  const dur = t.completedAt && t.startedAt ? formatOrchDuration(t.completedAt - t.startedAt) : '';
  const prompt = String(t.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim();
  const parts = ['# Symphonee task: ' + (prompt.split(/[.\n]/)[0] || 'untitled').slice(0, 80), '', '- Runner: ' + cliLabel + (t.model ? ' (' + t.model + ')' : ''), '- Status: ' + (t.state || 'unknown'), dur ? '- Duration: ' + dur : '', '', '## Prompt', '', prompt || '(empty)', '', '## Result', '', String(t.result || t.error || '(no output)').trim()].filter(Boolean);
  const md = parts.join('\n');
  try {
    await navigator.clipboard.writeText(md);
    toast('Copied task as markdown', 'success', {
      action: {
        label: 'Save as note',
        onClick: () => _saveTaskAsNote(t, md)
      }
    });
  } catch (err) {
    toast('Clipboard blocked: ' + err.message, 'error');
  }
}
async function _saveTaskAsNote(t, md) {
  const slug = String((t.prompt || '').split(/[.\n]/)[0] || 'task').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'task';
  const name = 'task-' + slug + '-' + String(t.id).slice(-6);
  try {
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        content: md
      })
    });
    toast('Saved note: ' + name, 'success', {
      action: {
        label: 'Open',
        onClick: () => {
          switchTab('notes');
          setTimeout(() => openNote(name), 80);
        }
      }
    });
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}
async function orchCleanup() {
  const ok = await confirmDialog('Clear all completed, failed, and timed out tasks?', {
    confirmText: 'Clear All',
    danger: true
  });
  if (!ok) return;
  // Clean up everything (maxAgeMs=0 removes all non-running tasks)
  const res = await fetch('/api/orchestrator/cleanup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      maxAgeMs: 0
    })
  }).then(r => r.json());
  _orchTaskOutput.clear();
  if (res.cleaned > 0) toast(res.cleaned + ' task(s) cleaned up', 'success');else toast('Nothing to clean up', 'info');
  orchRefreshTasks();
}
const CLI_COLORS = {
  claude: '#d97757',
  gemini: '#078efa',
  copilot: '#8534f3',
  codex: '#10a37f',
  grok: '#ef4444',
  qwen: '#615ced'
};
async function orchShowDispatchDialog() {
  // Collect running agents and all available CLIs for spawn
  const agents = state.orchAgents.filter(a => {
    const st = typeof termAiState !== 'undefined' ? termAiState.get(a.termId) : null;
    return st?.launched;
  });

  // Fetch repos for the repo selector
  let repos = {};
  let activeRepo = '';
  try {
    const [repoData, ctxData] = await Promise.all([fetch('/api/repos').then(r => r.json()), fetch('/api/ui/context').then(r => r.json())]);
    repos = repoData || {};
    activeRepo = ctxData.activeRepo || '';
  } catch (_) {}
  const noRepoSelected = !activeRepo;
  const repoOptions = '<option value=""' + (noRepoSelected ? ' selected' : '') + '>No Repo</option>' + Object.entries(repos).map(([name, repoPath]) => '<option value="' + name + '"' + (name === activeRepo ? ' selected' : '') + '>' + name + '</option>').join('');

  // Build agent option cards (running agents + spawn options)
  let agentCards = '';
  agents.forEach(a => {
    const st = termAiState.get(a.termId);
    const cli = st?.cli || 'unknown';
    const label = CLI_CONFIG[cli]?.label || cli;
    const color = CLI_COLORS[cli] || 'var(--overlay1)';
    agentCards += '<button class="orch-dispatch-agent" data-value="' + a.termId + '" data-mode="dispatch" onclick="orchSelectDispatchTarget(this)">' + '<span class="orch-dispatch-dot" style="background:' + color + '"></span>' + '<span class="orch-dispatch-label">' + label + '</span>' + '<span class="orch-dispatch-sub">' + a.termId + ' - inject into running session</span>' + '</button>';
  });
  // Spawn options (visible terminal)
  Object.entries(CLI_CONFIG).forEach(([k, v]) => {
    const color = CLI_COLORS[k] || 'var(--overlay1)';
    agentCards += '<button class="orch-dispatch-agent" data-value="spawn:' + k + '" data-mode="spawn" onclick="orchSelectDispatchTarget(this)">' + '<span class="orch-dispatch-dot" style="background:' + color + '"></span>' + '<span class="orch-dispatch-label">' + v.label + '</span>' + '<span class="orch-dispatch-sub">spawn new terminal</span>' + '</button>';
  });
  const overlay = document.createElement('div');
  overlay.id = 'orchDispatchOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
  overlay.innerHTML = '<div style="background:var(--base);border:1px solid var(--surface1);border-radius:var(--radius-lg);padding:0;width:520px;max-width:90vw;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.6);">' + '<div style="padding:16px 20px;border-bottom:1px solid var(--surface0);display:flex;align-items:center;gap:8px;">' + '<i data-lucide="send" style="width:16px;height:16px;color:var(--accent);"></i>' + '<span style="font-size:14px;font-weight:600;color:var(--text);">Dispatch Task</span>' + '</div>' + '<div style="padding:16px 20px;">' + '<div style="display:flex;gap:12px;margin-bottom:16px;">' + '<div style="flex:1;">' + '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--overlay1);margin-bottom:6px;">Repository</div>' + '<select id="orchDispatchRepo" style="width:100%;padding:8px 10px;background:var(--surface0);color:var(--text);border:1px solid var(--surface1);border-radius:var(--radius);font:12px var(--font-ui);outline:none;transition:border-color 0.15s;" onfocus="this.style.borderColor=\'var(--accent)\'" onblur="this.style.borderColor=\'var(--surface1)\'">' + repoOptions + '</select>' + '</div>' + '</div>' + '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--overlay1);margin-bottom:8px;">Target</div>' + '<div id="orchDispatchAgentList" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;">' + agentCards + '</div>' + '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--overlay1);margin:16px 0 8px;">Prompt</div>' + '<textarea id="orchDispatchPrompt" rows="5" style="width:100%;padding:10px 12px;background:var(--surface0);color:var(--text);border:1px solid var(--surface1);border-radius:var(--radius);font:12px/1.5 var(--font-mono);resize:vertical;outline:none;box-sizing:border-box;transition:border-color 0.15s;" onfocus="this.style.borderColor=\'var(--accent)\'" onblur="this.style.borderColor=\'var(--surface1)\'" placeholder="Describe the task for the target AI..."></textarea>' + '</div>' + '<div style="padding:12px 20px;border-top:1px solid var(--surface0);display:flex;gap:8px;justify-content:flex-end;background:var(--mantle);">' + '<button onclick="document.getElementById(\'orchDispatchOverlay\').remove()" style="padding:8px 16px;background:var(--surface1);color:var(--text);border:none;border-radius:var(--radius);font:12px var(--font-ui);cursor:pointer;transition:background 0.1s;" onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'var(--surface1)\'">Cancel</button>' + '<button onclick="orchDoDispatch()" style="padding:8px 16px;background:var(--accent);color:var(--crust);border:none;border-radius:var(--radius);font:12px var(--font-ui);font-weight:600;cursor:pointer;transition:opacity 0.1s;" onmouseenter="this.style.opacity=0.9" onmouseleave="this.style.opacity=1">Dispatch</button>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });
  try {
    lucide.createIcons({
      attrs: {
        class: ''
      },
      nameAttr: 'data-lucide'
    });
  } catch (_) {}
  // Auto-select first agent
  const first = overlay.querySelector('.orch-dispatch-agent');
  if (first) first.classList.add('selected');
  setTimeout(() => document.getElementById('orchDispatchPrompt')?.focus(), 50);
}
function orchSelectDispatchTarget(el) {
  el.closest('#orchDispatchAgentList').querySelectorAll('.orch-dispatch-agent').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
}
async function orchDoDispatch() {
  const selected = document.querySelector('#orchDispatchAgentList .orch-dispatch-agent.selected');
  const target = selected?.dataset.value;
  const mode = selected?.dataset.mode;
  const rawPrompt = document.getElementById('orchDispatchPrompt')?.value?.trim();
  const repoSelect = document.getElementById('orchDispatchRepo');
  const repoName = repoSelect?.value || '';
  document.getElementById('orchDispatchOverlay')?.remove();
  if (!target || !rawPrompt) return;

  // Prepend repo context so the AI knows which repo to work on
  let prompt = rawPrompt;
  if (repoName) {
    try {
      const repos = await fetch('/api/repos').then(r => r.json());
      const repoPath = repos[repoName];
      if (repoPath) {
        prompt = `[REPO CONTEXT] Work on the "${repoName}" repository located at: ${repoPath.replace(/\\/g, '/')}\nAll file reads, searches, and edits should target that directory. Do NOT cd there - stay in your current directory but use the full path for file operations.\n\n${rawPrompt}`;
      }
    } catch (_) {}
  }
  try {
    if (mode === 'spawn') {
      const cli = target.replace('spawn:', '');
      await fetch('/api/orchestrator/spawn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cli,
          prompt,
          space: state.activeSpace || null
        })
      });
      toast('Task dispatched to ' + cli, 'success');
    } else {
      await fetch('/api/orchestrator/dispatch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          targetTermId: target,
          prompt
        })
      });
      toast('Task dispatched to ' + target, 'success');
    }
    orchRefreshTasks();
  } catch (err) {
    toast('Dispatch failed: ' + err.message, 'error');
  }
}

// Listen for orchestrator WebSocket events
function handleOrchestratorEvent(msg) {
  if (msg.event === 'provider-failover') {
    const fromLabel = CLI_CONFIG[msg.from] && CLI_CONFIG[msg.from].label || msg.from;
    const toLabel = msg.to ? CLI_CONFIG[msg.to] && CLI_CONFIG[msg.to].label || msg.to : 'next available AI';
    const chain = Array.isArray(msg.chain) ? msg.chain.map(c => CLI_CONFIG[c] && CLI_CONFIG[c].label || c).join(' -> ') : '';
    const reason = msg.reason || 'provider error';
    const body = `${fromLabel} was skipped: ${reason}. Falling back to ${toLabel}.${chain ? ' Remaining chain: ' + chain + '.' : ''}`;
    if (msg.taskId) {
      _orchTaskOutput.delete(msg.taskId);
      const outputEl = document.querySelector(`.orch-task-output[data-output-id="${msg.taskId}"]`);
      if (outputEl) outputEl.textContent = '';
      const stepEl = document.querySelector(`.orch-task-step[data-step-id="${msg.taskId}"]`);
      if (stepEl) {
        stepEl.textContent = 'Working...';
        stepEl.removeAttribute('title');
      }
    }
    if (typeof notify === 'function') {
      notify('AI provider skipped', body, {
        icon: 'alert-triangle',
        source: 'orchestrator',
        taskId: msg.taskId || null,
        severity: 'warning'
      });
    }
    if (msg.taskId) {
      _clearPaletteDispatchToast(msg.taskId);
      _showPaletteDispatchToast(msg.taskId, msg.to, `${fromLabel} skipped: ${reason}. Sent to ${toLabel}.`);
    } else {
      toast(`${fromLabel}: ${reason} - falling back to ${toLabel}`, 'warning', {
        rich: true,
        duration: 6500
      });
    }
    return;
  }
  if (msg.event === 'provider-exhausted') {
    const lastLabel = CLI_CONFIG[msg.lastCli] && CLI_CONFIG[msg.lastCli].label || msg.lastCli;
    if (typeof notify === 'function') {
      notify('All AI providers failed', `The waterfall stopped after ${lastLabel}: ${msg.reason || 'failed'}. Add credits, log in, or configure another provider in Settings.`, {
        icon: 'alert-circle',
        source: 'orchestrator',
        taskId: msg.taskId || null,
        severity: 'error'
      });
    }
    if (msg.taskId) _clearPaletteDispatchToast(msg.taskId);
    toast(`All AI providers exhausted (last: ${lastLabel} - ${msg.reason || 'failed'}). Add credits or another API key in Settings.`, 'error', {
      rich: true,
      duration: 8000
    });
    return;
  }
  if (msg.event === 'task-update') {
    orchRefreshTasks();
    orchRefreshAgents();

    // Update orchestrated terminal indicators on task completion
    const task = msg.task;
    if (task && task.targetTermId && task.type === 'visible') {
      const st = termAiState.get(task.targetTermId);
      if (st && st.orchestrated && task.state !== 'running' && task.state !== 'pending') {
        const dot = document.querySelector(`.term-tab[data-term="${task.targetTermId}"] .orch-dot`);
        if (dot) {
          dot.classList.add('done');
          setTimeout(() => dot.remove(), 3000);
        }
        st.orchestrated = false;
      }
    }

    // Generic completion toast + success chime for ANY orchestrator task
    // (so the user gets feedback even when a worker finishes off-screen).
    // Skipped if the task surfaces through the richer palette/quick-ask
    // notification path below (which already plays the success sound via
    // notify()) so we don't double-notify.
    if (task && task.state === 'completed' && !_paletteNotifyTasks.has(task.id) && task.from !== 'palette' && task.from !== 'quick-ask') {
      if (typeof toast === 'function') {
        const cli = task.cli || 'AI';
        const cliLabel = CLI_CONFIG[cli] && CLI_CONFIG[cli].label || cli;
        const promptSnippet = String(task.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim().split(/[.\n]/)[0].slice(0, 80);
        toast(`${cliLabel} task done${promptSnippet ? ': ' + promptSnippet : ''}`, 'success', {
          duration: 5000
        });
      }
    }

    // Palette / quick-ask tasks: push the final answer to the notification
    // center when they complete. Matches by taskId captured at spawn time,
    // or falls back to the task's `from` tag for cases where the spawn
    // response wasn't tracked (e.g. reloads mid-flight).
    if (task && task.state === 'completed') {
      const tracked = _paletteNotifyTasks.has(task.id);
      const fromTag = task.from === 'palette' || task.from === 'quick-ask';
      if (tracked || fromTag) {
        _paletteNotifyTasks.delete(task.id);
        _clearPaletteDispatchToast(task.id);
        const cli = task.cli || 'AI';
        const cliLabel = CLI_CONFIG[cli] && CLI_CONFIG[cli].label || cli;
        const promptSnippet = (task.prompt || '').replace(/\[ORCHESTRATOR TASK [^\]]*\]/g, '').trim().split(/[.\n]/)[0].slice(0, 90);
        const answer = (task.result || task.error || '(no output captured)').toString();
        notify(cliLabel + ' answered: ' + (promptSnippet || 'your question'), answer, {
          icon: 'sparkles',
          source: task.from,
          taskId: task.id
        });
      } else if (task.state === 'failed' && _paletteNotifyTasks.has(task.id)) {
        _paletteNotifyTasks.delete(task.id);
        _clearPaletteDispatchToast(task.id);
        notify('AI task failed', (task.error || 'Unknown error').toString(), {
          icon: 'alert-circle'
        });
      }
    }
  }
  // Live output streaming for headless tasks
  if (msg.event === 'task-output' && msg.taskId) {
    const prev = _orchTaskOutput.get(msg.taskId) || '';
    _orchTaskOutput.set(msg.taskId, prev + (msg.chunk || ''));
    // Keep the in-card "current step" line in sync without a full re-render.
    const stepEl = document.querySelector(`.orch-task-step[data-step-id="${msg.taskId}"]`);
    if (stepEl) {
      const full = _orchTaskOutput.get(msg.taskId);
      const lines = full.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length) {
        const last = lines[lines.length - 1].slice(0, 120);
        stepEl.textContent = last;
        stepEl.title = last;
      }
    }
    const outputEl = document.querySelector(`.orch-task-output[data-output-id="${msg.taskId}"]`);
    if (outputEl) {
      const full = _orchTaskOutput.get(msg.taskId);
      outputEl.textContent = full.substring(full.length - 2000);
      outputEl.scrollTop = outputEl.scrollHeight;
    } else {
      renderOrchTasks();
    }
  }
  // Watcher events: show what the orchestrator agent is doing
  if (msg.event === 'watcher' && msg.taskId) {
    const statusEl = document.querySelector(`.orch-task[data-id="${msg.taskId}"] .orch-watcher-status`);
    if (statusEl) {
      statusEl.textContent = msg.action;
      statusEl.style.display = '';
      clearTimeout(statusEl._fadeTimer);
      statusEl._fadeTimer = setTimeout(() => {
        statusEl.style.display = 'none';
      }, 5000);
    }
  }
  // Orchestration mode change
  if (msg.event === 'mode-change') {
    setOrchestrationMode(msg.orchestrating);
  }
}
function setOrchestrationMode(active) {
  const mainTab = document.getElementById('mainTermTab');
  const orchBtn = document.getElementById('orchestratorTabBtn');
  if (active) {
    // Add orchestrator badge to main terminal tab
    if (mainTab && !mainTab.querySelector('.orch-mode-badge')) {
      const badge = document.createElement('span');
      badge.className = 'orch-mode-badge';
      badge.textContent = 'Orchestrating';
      mainTab.appendChild(badge);
    }
    // Add pulsating dot to orchestrator tab
    if (orchBtn && !orchBtn.querySelector('.orch-pulse-dot')) {
      const dot = document.createElement('span');
      dot.className = 'orch-pulse-dot';
      orchBtn.appendChild(dot);
    }
  } else {
    // Remove orchestrator badge
    if (mainTab) {
      const badge = mainTab.querySelector('.orch-mode-badge');
      if (badge) badge.remove();
    }
    // Remove pulsating dot
    if (orchBtn) {
      const dot = orchBtn.querySelector('.orch-pulse-dot');
      if (dot) dot.remove();
    }
  }
}// ── Bottom Hints Visibility ─────────────────────────────────────────────
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
setTimeout(checkForUpdates, 5000);// ── Collapsible side panels ───────────────────────────────────────────────
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
}// ── Config ──────────────────────────────────────────────────────────────
state._configLoaded = false;
async function loadConfig(autoSelectSprint) {
  try {
    const res = await fetch('/api/config');
    state.configData = await res.json();
    try {
      loadHotkeys();
    } catch (_) {}
    try {
      applyInappBrowserAppearance();
    } catch (_) {}
    document.getElementById('projectLabel').textContent = 'Settings';
    // Plugin presence drives shell visibility. Config keys are owned by plugins
    // now and the loader filters /api/plugins by activationConditions, so a plugin
    // appearing in _loadedPlugins implies its config is satisfied.
    const hasAdo = !!(state._loadedPlugins || []).some(p => p.contributions && p.contributions.workItemProvider);
    const hasGh = !!(state._loadedPlugins || []).some(p => p.contributions && p.contributions.prProvider);
    // Plugin-driven surfaces depend on _loadedPlugins, so this is also rerun
    // after plugin init completes to close the cold-start race.
    reconcilePluginShellSurfaces();
    // Left-column Git actions: only useful once a repo is selected.
    var _gitActionsEl = document.getElementById('sidebarGitActions');
    if (_gitActionsEl) {
      var _hasActiveRepo = state.configData.Repos && Object.keys(state.configData.Repos).length > 0;
      _gitActionsEl.style.display = _hasActiveRepo ? '' : 'none';
    }
    // Git modal: hide Pull/Push when no PAT (local ops like Branches/Commit/Compare still work)
    const hasPat = !!(state.configData.GitHubPAT && state.configData.GitHubPAT.trim());
    const gitAuthOk = hasGh || hasPat;
    const gitPullBtn = document.getElementById('gitNavPull');
    const gitPushBtn = document.getElementById('gitNavPush');
    const gitNoPatHint = document.getElementById('gitNavNoPatHint');
    if (gitPullBtn) gitPullBtn.style.display = gitAuthOk ? '' : 'none';
    if (gitPushBtn) gitPushBtn.style.display = gitAuthOk ? '' : 'none';
    if (gitNoPatHint) gitNoPatHint.style.display = gitAuthOk ? 'none' : '';
    document.getElementById('orchestratorTabBtn').style.display = '';
    // Repo list is core, not ADO-specific; always load it.
    loadRepoList();
    if (hasAdo) {
      loadTeams();
      loadAreas();
      await loadIterations(autoSelectSprint);
      loadTeamMembers();
    }
    // Apply saved default CLI on first load
    if (!state._configLoaded && state.configData.DefaultCli && CLI_CONFIG[state.configData.DefaultCli]) {
      switchCli(state.configData.DefaultCli);
      state._configLoaded = true;
    }
    updateScreenHint();
  } catch (_) {}
}

// ── Iterations ──────────────────────────────────────────────────────────
async function loadIterations(autoSelectCurrent) {
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'iterationsRoute', {}));
    if (!res) return;
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    const select = document.getElementById('sprintSelect');
    select.innerHTML = '<option value="">All Iterations</option>';
    let currentPath = '';
    let firstPath = '';
    for (const it of data) {
      const opt = document.createElement('option');
      opt.value = it.path;
      opt.textContent = it.name + (it.isCurrent ? ' (current)' : '');
      select.appendChild(opt);
      if (!firstPath) firstPath = it.path;
      if (it.isCurrent) currentPath = it.path;
    }
    // Default to "All Iterations" even when switching projects; user can pick a specific sprint manually.
    void autoSelectCurrent;
    void firstPath;
    await loadWorkItems(!!autoSelectCurrent);
    if (currentPath) {
      loadBurndown(currentPath);
      updateSprintCard(data.find(i => i.isCurrent));
    }
    pushUiContext();
  } catch (_) {}
}
function onSprintChange() {
  state.closedItemsLimit = 10; // reset pagination when switching iterations
  loadWorkItems();
  const path = document.getElementById('sprintSelect').value;
  if (path) loadBurndown(path);
  pushUiContext();
  const name = (document.getElementById('sprintSelect').selectedOptions[0] || {}).textContent || '';
  notifyPluginIframes('iterationChanged', {
    iteration: path,
    name: name
  });
}
function pushUiContext() {
  const sel = document.getElementById('sprintSelect');
  const areaSel = document.getElementById('areaSelect');
  const ctx = {
    selectedIteration: sel.value || null,
    selectedIterationName: sel.selectedOptions[0]?.textContent || 'All Iterations',
    selectedArea: areaSel?.value || null,
    selectedAreaName: areaSel?.selectedOptions[0]?.textContent?.trim() || 'Team Default',
    activeSpace: state.activeSpace || null,
    activeRepo: state.activeRepo || state.filesCurrentRepo || null
  };
  fetch('/api/ui/context', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ctx)
  }).catch(() => {});
}

// Current notes namespace - what /api/notes calls should default to. '_global'
// when no space is active; the space's slugged name otherwise.
function currentNotesNs() {
  if (!state.activeSpace) return '_global';
  return String(state.activeSpace).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || '_global';
}

// Fetch wrapper that scopes notes API calls to the active space's namespace.
// Adds ns= to GET querystrings and injects ns into POST/PUT/DELETE bodies.
function notesFetch(url, init) {
  const ns = currentNotesNs();
  init = init || {};
  const method = (init.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'DELETE' && !init.body) {
    const sep = url.includes('?') ? '&' : '?';
    return fetch(url + sep + 'ns=' + encodeURIComponent(ns), init);
  }
  if (init.body && typeof init.body === 'string') {
    try {
      const obj = JSON.parse(init.body);
      if (obj && typeof obj === 'object' && obj.ns === undefined) {
        obj.ns = ns;
        init = {
          ...init,
          body: JSON.stringify(obj)
        };
      }
    } catch (_) {}
  }
  return fetch(url, init);
}

// ── Work Items ──────────────────────────────────────────────────────────
async function loadWorkItems(refresh = false) {
  const iteration = document.getElementById('sprintSelect').value;
  const area = document.getElementById('areaSelect')?.value || '';
  const params = new URLSearchParams();
  if (iteration) params.set('iteration', iteration);
  if (area) params.set('area', area);
  if (refresh) params.set('refresh', '1');
  params.set('closedTop', String(state.closedItemsLimit));
  // Track the active query key so SWR broadcasts can be matched
  const keyIter = iteration || '';
  state._activeWiCacheKey = 'wi:' + `${keyIter}||||${area}|ct${state.closedItemsLimit}`;
  const taskId = addBackgroundTask('wi-load-' + Date.now(), 'Loading work items', 'list-checks');
  try {
    const res = await window.Symphonee?.contributions?.providerFetch?.('workItem', 'listRoute', {
      query: params.toString()
    });
    if (!res) {
      state.workItems = [];
      renderBacklog();
      return;
    }
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }
    // Support both new { items, hasMoreClosed, totalClosed } and legacy array format
    if (Array.isArray(data)) {
      state.workItems = data;
      state.hasMoreClosed = false;
      state.totalClosedCount = 0;
      state.totalClosedCapped = false;
    } else {
      state.workItems = data.items || [];
      state.hasMoreClosed = data.hasMoreClosed || false;
      state.totalClosedCount = data.totalClosed || 0;
      state.totalClosedCapped = data.totalClosedCapped || false;
    }
    populateTagFilters();
    document.querySelectorAll('.multi-select').forEach(ms => updateMultiSelectLabel(ms));
    renderBoard();
    renderBacklog();
    updateActivityFeed();
    // Re-render timeline if it's open
    if (document.getElementById('activityTabBtn').style.display !== 'none') renderTimeline();
    completeBackgroundTask(taskId, true);
  } catch (e) {
    toast('Failed to load work items', 'error');
    completeBackgroundTask(taskId, false);
  }
}
function loadMoreClosed() {
  state.closedItemsLimit += 15;
  loadWorkItems(true);
}
function populateTagFilters() {
  const tags = new Set();
  state.workItems.forEach(wi => {
    if (wi.tags) wi.tags.split(';').forEach(t => {
      const trimmed = t.trim();
      if (trimmed) tags.add(trimmed);
    });
  });
  const sorted = [...tags].sort((a, b) => a.localeCompare(b));
  const toggleAllHtml = sorted.length > 0 ? `<div class="multi-select-toggle-all selected" onclick="toggleAllMultiItems(this)">Toggle All</div>` : '';
  const noTagHtml = `<div class="multi-select-item selected" data-value="__none__" onclick="toggleMultiItem(this)"><div class="multi-select-toggle"></div> (No Tag)</div>`;
  const html = toggleAllHtml + noTagHtml + sorted.map(tag => `<div class="multi-select-item selected" data-value="${esc(tag)}" onclick="toggleMultiItem(this)"><div class="multi-select-toggle"></div> ${esc(tag)}</div>`).join('');
  const backlogPanel = document.getElementById('backlogTagPanel');
  if (backlogPanel) backlogPanel.innerHTML = html;
}
function filterMyItems() {
  const user = state.configData.DefaultUser || '';
  if (!user) {
    toast('Set your display name in Settings first', 'info');
    openSettings();
    return;
  }
  filterByUser(user);
}
function filterByUser(name) {
  document.getElementById('backlogSearch').value = name;
  switchTab('backlog', true);
  filterBacklog();
}

// ── Board Rendering ─────────────────────────────────────────────────────
// ── Multi-Select Dropdown Logic ──────────────────────────────────────────
function toggleMultiSelect(el) {
  // Close others first
  document.querySelectorAll('.multi-select.open').forEach(ms => {
    if (ms !== el) ms.classList.remove('open');
  });
  el.classList.toggle('open');
}
function toggleMultiItem(item) {
  item.classList.toggle('selected');
  const ms = item.closest('.multi-select');
  // Sync the Toggle All switch
  const toggleAll = ms.querySelector('.multi-select-toggle-all');
  if (toggleAll) {
    const allItems = ms.querySelectorAll('.multi-select-item');
    const allSelected = [...allItems].every(i => i.classList.contains('selected'));
    toggleAll.classList.toggle('selected', allSelected);
  }
  updateMultiSelectLabel(ms);
  const fn = ms.dataset.onchange;
  if (fn && window[fn]) window[fn]();
}
function toggleAllMultiItems(toggleAllEl) {
  const ms = toggleAllEl.closest('.multi-select');
  const items = ms.querySelectorAll('.multi-select-item');
  const allSelected = [...items].every(i => i.classList.contains('selected'));
  // If all on -> turn all off. If any off -> turn all on.
  items.forEach(i => i.classList.toggle('selected', !allSelected));
  toggleAllEl.classList.toggle('selected', !allSelected);
  updateMultiSelectLabel(ms);
  const fn = ms.dataset.onchange;
  if (fn && window[fn]) window[fn]();
}
function getMultiSelectValues(dataId) {
  const ms = document.querySelector(`.multi-select[data-id="${dataId}"]`);
  if (!ms) return [];
  return [...ms.querySelectorAll('.multi-select-item.selected')].map(el => el.dataset.value);
}
function updateMultiSelectLabel(ms) {
  const allItems = [...ms.querySelectorAll('.multi-select-item')];
  const selected = allItems.filter(i => i.classList.contains('selected'));
  const hidden = allItems.length - selected.length;
  const label = ms.querySelector('.multi-select-label');
  const countBadge = ms.querySelector('.multi-select-count');
  const defaultLabel = ms.querySelector('.multi-select-btn').dataset.label || label.textContent.split(' ')[0];
  label.textContent = defaultLabel;
  if (countBadge) {
    countBadge.textContent = selected.length;
    countBadge.classList.add('visible');
  }
}

// Close multi-selects when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.multi-select')) {
    document.querySelectorAll('.multi-select.open').forEach(ms => ms.classList.remove('open'));
  }
});
const HIDDEN_TYPES = ['Test Case', 'Test Suite'];

// Check if a work item has an "on hold", "hold", or "pending" tag (case-insensitive, with or without dash/space)
function isOnHold(wi) {
  if (!wi.tags) return false;
  return wi.tags.split(';').some(t => {
    const tag = t.trim().toLowerCase();
    return /^on[\s-]?hold$/.test(tag) || tag === 'hold' || tag === 'pending';
  });
}

// Track expanded parents across renders (default: collapsed; persisted in localStorage)
const _expandedParents = new Set(JSON.parse(localStorage.getItem('symphonee-expanded-parents') || '[]'));
function toggleParentCollapse(parentId, event) {
  event.stopPropagation();
  if (_expandedParents.has(parentId)) _expandedParents.delete(parentId);else _expandedParents.add(parentId);
  localStorage.setItem('symphonee-expanded-parents', JSON.stringify([..._expandedParents]));
  renderBoard();
}

// Highlight all family members (parent + children) on hover
function highlightFamily(parentId, on) {
  document.querySelectorAll(`[data-family="${parentId}"]`).forEach(el => {
    el.classList.toggle('family-highlight', on);
  });
}

// State colors for rollup bar
const STATE_COLORS = {
  New: 'var(--blue)',
  Active: 'var(--green)',
  Resolved: 'var(--mauve)',
  Closed: 'var(--subtext0)',
  Done: 'var(--subtext0)'
};
function renderBoard() {
  const search = (document.getElementById('backlogSearch')?.value || '').toLowerCase();
  const typeFilters = getMultiSelectValues('backlogType');
  const stateFilters = getMultiSelectValues('backlogState');
  const tagFilters = getMultiSelectValues('backlogTag');
  let filtered = state.workItems;
  // Filters are ON by default; deselected items are hidden
  filtered = filtered.filter(wi => typeFilters.includes(wi.type));
  filtered = filtered.filter(wi => stateFilters.includes(wi.state));
  const totalTags = document.querySelectorAll('#backlogTagPanel .multi-select-item').length;
  if (totalTags > 0 && tagFilters.length < totalTags) {
    const showNoTag = tagFilters.includes('__none__');
    filtered = filtered.filter(wi => {
      const wiTags = wi.tags ? wi.tags.split(';').map(t => t.trim()).filter(Boolean) : [];
      if (wiTags.length === 0) return showNoTag;
      return wiTags.every(t => tagFilters.includes(t));
    });
  }
  if (search) filtered = filtered.filter(wi => wi.title.toLowerCase().includes(search) || String(wi.id).includes(search) || wi.assignedTo.toLowerCase().includes(search));

  // Build global parent-child index across ALL columns
  const allItemMap = new Map(filtered.map(wi => [wi.id, wi]));
  const childrenOf = new Map(); // parentId -> [all child items across all states]
  const parentOf = new Map(); // childId -> parent item

  for (const wi of filtered) {
    if (wi.parentId && allItemMap.has(wi.parentId)) {
      parentOf.set(wi.id, allItemMap.get(wi.parentId));
      if (!childrenOf.has(wi.parentId)) childrenOf.set(wi.parentId, []);
      childrenOf.get(wi.parentId).push(wi);
    }
  }
  const buckets = {
    New: [],
    Active: [],
    Resolved: [],
    Closed: []
  };
  for (const wi of filtered) {
    const state = wi.state;
    if (buckets[state]) buckets[state].push(wi);else if (state === 'Done') buckets.Closed.push(wi);else buckets.New.push(wi); // fallback
  }

  // Build child rollup HTML for a parent card (only if it actually has children)
  function childRollupHtml(parentId) {
    const children = childrenOf.get(parentId);
    if (!children || children.length === 0) return ''; // no children = no bar
    const total = children.length;
    const closedCount = children.filter(c => c.state === 'Closed' || c.state === 'Done').length;
    const allDone = closedCount === total;
    const pct = (closedCount / total * 100).toFixed(1);
    return `
      <div class="child-rollup">
        <div class="child-rollup-bar"><span style="width:${pct}%;background:var(--green)"></span></div>
        <span class="child-rollup-label ${allDone ? 'child-rollup-complete' : ''}">${closedCount}/${total} closed</span>
      </div>`;
  }

  // Render a single board card
  function boardCardHtml(wi, extraClass = '', opts = {}) {
    const familyId = opts.familyId || '';
    const parentRef = opts.parentRef || null;
    const isParent = opts.isParent || false;
    const childCount = isParent ? (childrenOf.get(wi.id) || []).length : 0;
    const collapsed = !_expandedParents.has(wi.id);
    let toggleBtn = '';
    if (isParent && childCount > 0) {
      // Only show toggle if there are same-column children
      const sameColChildren = (childrenOf.get(wi.id) || []).filter(c => {
        const cs = c.state === 'Done' ? 'Closed' : c.state;
        const ws = wi.state === 'Done' ? 'Closed' : wi.state;
        return cs === ws;
      });
      if (sameColChildren.length > 0) {
        toggleBtn = `<button class="parent-toggle" onclick="toggleParentCollapse(${wi.id}, event)" title="${collapsed ? 'Expand' : 'Collapse'} children"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>`;
      }
    }
    let parentRefHtml = '';
    if (parentRef) {
      parentRefHtml = `<div class="child-parent-ref"><span onclick="event.stopPropagation();viewWorkItem(${parentRef.id})" title="${esc(parentRef.title)}">↑ #${parentRef.id} ${esc(parentRef.title.substring(0, 30))}${parentRef.title.length > 30 ? '…' : ''}</span></div>`;
    }
    return `
      <div class="board-card ${extraClass} ${parentRef ? 'has-parent' : ''} ${isOnHold(wi) ? 'on-hold' : ''}" draggable="true" data-wi-id="${wi.id}"
           ${familyId ? `data-family="${familyId}"` : ''}
           onclick="viewWorkItem(${wi.id})"
           ondragstart="onCardDragStart(event, ${wi.id})" ondragend="onCardDragEnd(event)"
           ${familyId ? `onmouseenter="highlightFamily(${familyId}, true)" onmouseleave="highlightFamily(${familyId}, false)"` : ''}>
        ${parentRefHtml}
        ${toggleBtn}
        <div class="board-card-id"><span>#${wi.id}</span>${isOnHold(wi) ? '<span class="on-hold-label">On Hold</span>' : ''}</div>
        <div class="board-card-title">${esc(wi.title)}</div>
        <div class="board-card-meta">
          <span class="board-card-type type-${wi.type.toLowerCase().replace(/\s+/g, '-')}">${wi.type}</span>
          ${wi.assignedTo ? `<span>${esc(wi.assignedTo.split(' ')[0])}</span>` : ''}
          ${wi.storyPoints ? `<span>${wi.storyPoints} pts</span>` : ''}
        </div>
        ${isParent ? childRollupHtml(wi.id) : ''}
      </div>`;
  }
  for (const [state, items] of Object.entries(buckets)) {
    const container = document.getElementById(`board${state}`);
    const count = document.getElementById(`boardCount${state}`);
    if (!container) continue;
    // For Closed column, show total count (from API) when available, not just loaded count
    if (state === 'Closed' && window.state.totalClosedCount > items.length) {
      count.textContent = window.state.totalClosedCapped ? window.state.totalClosedCount + '+' : window.state.totalClosedCount;
    } else {
      count.textContent = items.length;
    }

    // Identify same-column children (parent is in this same column)
    const colItemMap = new Map(items.map(wi => [wi.id, wi]));
    const sameColChildIds = new Set();
    for (const wi of items) {
      if (wi.parentId && colItemMap.has(wi.parentId)) {
        sameColChildIds.add(wi.id);
      }
    }
    let html = '';
    for (const wi of items) {
      if (sameColChildIds.has(wi.id)) continue; // rendered under parent group

      const sameColChildren = (childrenOf.get(wi.id) || []).filter(c => colItemMap.has(c.id));
      const hasAnyChildren = childrenOf.has(wi.id);
      if (sameColChildren.length > 0) {
        // Parent with children in same column — group them
        const collapsed = !_expandedParents.has(wi.id);
        html += `<div class="board-parent-group ${collapsed ? 'collapsed' : ''}" data-family="${wi.id}"
                      onmouseenter="highlightFamily(${wi.id}, true)" onmouseleave="highlightFamily(${wi.id}, false)">`;
        html += boardCardHtml(wi, 'parent-card', {
          isParent: true,
          familyId: wi.id
        });
        for (const child of sameColChildren) {
          html += boardCardHtml(child, 'child-card', {
            familyId: wi.id
          });
        }
        html += `</div>`;
      } else if (hasAnyChildren) {
        // Parent but all children are in other columns — show as standalone with rollup
        html += boardCardHtml(wi, '', {
          isParent: true,
          familyId: wi.id
        });
      } else if (parentOf.has(wi.id)) {
        // Child whose parent is in a different column — show parent reference
        const parent = parentOf.get(wi.id);
        html += boardCardHtml(wi, '', {
          parentRef: parent,
          familyId: parent.id
        });
      } else {
        // Regular standalone item
        html += boardCardHtml(wi);
      }
    }
    // Add "Show more" button to Closed column when there are more items
    // AND the user's state filter actually includes Closed/Done.
    if (state === 'Closed' && window.state.hasMoreClosed) {
      const stateFiltersNow = getMultiSelectValues('backlogState');
      if (stateFiltersNow.includes('Closed') || stateFiltersNow.includes('Done')) {
        const closedLabel = window.state.totalClosedCapped ? window.state.totalClosedCount + '+' : window.state.totalClosedCount;
        html += `<button class="show-more-closed-btn" onclick="event.stopPropagation(); loadMoreClosed();">Showing ${items.length} of ${closedLabel} - load more...</button>`;
      }
    }
    container.innerHTML = html;

    // Add drop handlers to column
    container.ondragover = e => {
      e.preventDefault();
      container.classList.add('drag-over');
    };
    container.ondragleave = () => container.classList.remove('drag-over');
    container.ondrop = e => {
      e.preventDefault();
      container.classList.remove('drag-over');
      onCardDrop(e, state);
    };
  }
}

// ── Backlog Rendering ───────────────────────────────────────────────────
const _collapsedBacklogParents = new Set(JSON.parse(localStorage.getItem('symphonee-collapsed-backlog') || '[]'));
function toggleBacklogParent(parentId, event) {
  event.stopPropagation();
  if (_collapsedBacklogParents.has(parentId)) _collapsedBacklogParents.delete(parentId);else _collapsedBacklogParents.add(parentId);
  localStorage.setItem('symphonee-collapsed-backlog', JSON.stringify([..._collapsedBacklogParents]));
  // Toggle child row visibility
  document.querySelectorAll(`tr[data-backlog-parent="${parentId}"]`).forEach(row => {
    row.classList.toggle('backlog-child-hidden', _collapsedBacklogParents.has(parentId));
  });
  // Toggle button icon
  const btn = document.querySelector(`button[data-backlog-toggle="${parentId}"]`);
  if (btn) btn.classList.toggle('collapsed', _collapsedBacklogParents.has(parentId));
}
function renderBacklog() {
  const body = document.getElementById('backlogBody');

  // Build parent-child index
  const allMap = new Map(state.workItems.map(wi => [wi.id, wi]));
  const childrenOf = new Map();
  const childIds = new Set();
  for (const wi of state.workItems) {
    if (wi.parentId && allMap.has(wi.parentId)) {
      childIds.add(wi.id);
      if (!childrenOf.has(wi.parentId)) childrenOf.set(wi.parentId, []);
      childrenOf.get(wi.parentId).push(wi);
    }
  }

  // Build rollup HTML for backlog
  function backlogRollupHtml(parentId) {
    const children = childrenOf.get(parentId);
    if (!children || children.length === 0) return '';
    const total = children.length;
    const closedCount = children.filter(c => c.state === 'Closed' || c.state === 'Done').length;
    const pct = (closedCount / total * 100).toFixed(1);
    return `<span class="backlog-child-rollup"><span class="child-rollup-bar"><span style="width:${pct}%;background:var(--green)"></span></span><span class="child-rollup-label">${closedCount}/${total}</span></span>`;
  }

  // Render rows: parents first, then their children indented
  let html = '';
  for (const wi of state.workItems) {
    if (childIds.has(wi.id)) continue; // rendered under parent

    const children = childrenOf.get(wi.id);
    const isParent = children && children.length > 0;
    const collapsed = _collapsedBacklogParents.has(wi.id);
    if (isParent) {
      const toggleBtn = `<button class="backlog-parent-toggle ${collapsed ? 'collapsed' : ''}" data-backlog-toggle="${wi.id}" onclick="toggleBacklogParent(${wi.id}, event)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>`;
      html += `
        <tr class="backlog-parent ${isOnHold(wi) ? 'on-hold' : ''}" onclick="viewWorkItem(${wi.id})">
          <td class="wi-id">${toggleBtn}${wi.id}</td>
          <td><span class="board-card-type type-${wi.type.toLowerCase().replace(/\s+/g, '-')}">${wi.type}</span></td>
          <td class="wi-title">${esc(wi.title)}${backlogRollupHtml(wi.id)}</td>
          <td><span class="state-badge state-${wi.state.toLowerCase()}">${wi.state}</span></td>
          <td>${esc(wi.assignedTo)}</td>
          <td class="priority-${wi.priority}">P${wi.priority}</td>
          <td>${wi.storyPoints || '-'}</td>
        </tr>`;
      for (const child of children) {
        html += `
          <tr class="backlog-child ${collapsed ? 'backlog-child-hidden' : ''} ${isOnHold(child) ? 'on-hold' : ''}" data-backlog-parent="${wi.id}" onclick="viewWorkItem(${child.id})">
            <td class="wi-id">${child.id}</td>
            <td><span class="board-card-type type-${child.type.toLowerCase().replace(/\s+/g, '-')}">${child.type}</span></td>
            <td class="wi-title">${esc(child.title)}</td>
            <td><span class="state-badge state-${child.state.toLowerCase()}">${child.state}</span></td>
            <td>${esc(child.assignedTo)}</td>
            <td class="priority-${child.priority}">P${child.priority}</td>
            <td>${child.storyPoints || '-'}</td>
          </tr>`;
      }
    } else {
      html += `
        <tr class="${isOnHold(wi) ? 'on-hold' : ''}" onclick="viewWorkItem(${wi.id})">
          <td class="wi-id">${wi.id}</td>
          <td><span class="board-card-type type-${wi.type.toLowerCase().replace(/\s+/g, '-')}">${wi.type}</span></td>
          <td class="wi-title">${esc(wi.title)}</td>
          <td><span class="state-badge state-${wi.state.toLowerCase()}">${wi.state}</span></td>
          <td>${esc(wi.assignedTo)}</td>
          <td class="priority-${wi.priority}">P${wi.priority}</td>
          <td>${wi.storyPoints || '-'}</td>
        </tr>`;
    }
  }
  // Add "Show more" row when there are more closed items AND the user's
  // state filter actually includes Closed/Done. Otherwise showing it is a
  // lie (the user can't see what they'd load) and clicking it appears to
  // inject closed items that should be filtered out.
  if (state.hasMoreClosed) {
    const stateFiltersNow = getMultiSelectValues('backlogState');
    const showsClosed = stateFiltersNow.includes('Closed') || stateFiltersNow.includes('Done');
    if (showsClosed) {
      const loadedClosed = state.workItems.filter(wi => wi.state === 'Closed' || wi.state === 'Done').length;
      const closedLabel = state.totalClosedCapped ? state.totalClosedCount + '+' : state.totalClosedCount;
      html += `<tr class="show-more-closed-row"><td colspan="7"><button class="show-more-closed-btn" onclick="event.stopPropagation(); loadMoreClosed();">Showing ${loadedClosed} of ${closedLabel} closed items - load more...</button></td></tr>`;
    }
  }
  body.innerHTML = html;
}

// ── Kanban Drag & Drop ──────────────────────────────────────────────────
state.draggedWiId = null;
function onCardDragStart(e, wiId) {
  e.stopPropagation(); // prevent child drag from bubbling to parent group
  state.draggedWiId = wiId;
  e.dataTransfer.effectAllowed = 'move';
  e.target.classList.add('dragging');
}
function onCardDragEnd(e) {
  e.target.classList.remove('dragging');
}
async function onCardDrop(e, targetState) {
  if (!state.draggedWiId) return;
  const wiId = state.draggedWiId;
  state.draggedWiId = null;

  // Find the work item to check if state actually changed
  const wi = state.workItems.find(w => w.id === wiId);
  if (!wi || wi.state === targetState) return;
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'updateStateRoute', {
      params: {
        id: wiId
      },
      init: {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          state: targetState
        })
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
    toast(`#${wiId} moved to ${targetState}`, 'success');
    // Optimistic update + full refresh from server
    wi.state = targetState;
    renderBoard();
    renderBacklog();
    loadWorkItems(true);
  } catch (e) {
    toast('Failed to update state', 'error');
  }
}
state._backlogView = 'list'; // 'list' | 'board'
function switchBacklogView(view) {
  state._backlogView = view;
  document.getElementById('btnViewList').classList.toggle('active', view === 'list');
  document.getElementById('btnViewBoard').classList.toggle('active', view === 'board');
  document.getElementById('backlogContainer').style.display = view === 'list' ? '' : 'none';
  document.getElementById('boardView').style.display = view === 'board' ? '' : 'none';
  applyBacklogFilters();
  try {
    lucide.createIcons();
  } catch (_) {}
}
function applyBacklogFilters() {
  if (state._backlogView === 'board') {
    renderBoard();
  } else {
    renderBacklog();
    filterBacklog();
  }
}
function filterBacklog() {
  const search = document.getElementById('backlogSearch').value.toLowerCase();
  const typeFilters = getMultiSelectValues('backlogType');
  const stateFilters = getMultiSelectValues('backlogState');
  const tagFilters = getMultiSelectValues('backlogTag');
  const totalTags = document.querySelectorAll('#backlogTagPanel .multi-select-item').length;
  const tagsFiltered = totalTags > 0 && tagFilters.length < totalTags;
  const hasFilters = search || tagsFiltered || typeFilters.length < document.querySelectorAll('[data-id="backlogType"] .multi-select-item').length || stateFilters.length < document.querySelectorAll('[data-id="backlogState"] .multi-select-item').length;
  function matchesFilter(wi) {
    const matchSearch = !search || wi.title.toLowerCase().includes(search) || wi.assignedTo.toLowerCase().includes(search) || String(wi.id).includes(search);
    const matchType = typeFilters.includes(wi.type);
    const matchState = stateFilters.includes(wi.state);
    let matchTag = true;
    if (tagsFiltered) {
      const showNoTag = tagFilters.includes('__none__');
      const wiTags = wi.tags ? wi.tags.split(';').map(t => t.trim()).filter(Boolean) : [];
      matchTag = wiTags.length === 0 ? showNoTag : wiTags.every(t => tagFilters.includes(t));
    }
    return matchSearch && matchType && matchState && matchTag;
  }

  // Build parent-child map for filter logic
  const allMap = new Map(state.workItems.map(wi => [wi.id, wi]));
  const childrenOf = new Map();
  for (const wi of state.workItems) {
    if (wi.parentId && allMap.has(wi.parentId)) {
      if (!childrenOf.has(wi.parentId)) childrenOf.set(wi.parentId, []);
      childrenOf.get(wi.parentId).push(wi);
    }
  }
  const rows = document.querySelectorAll('#backlogBody tr');
  let rowIdx = 0;
  for (const wi of state.workItems) {
    // Skip children in the flat loop — they're handled under their parent
    if (wi.parentId && allMap.has(wi.parentId)) continue;
    const children = childrenOf.get(wi.id) || [];
    const isParent = children.length > 0;
    if (isParent) {
      const parentMatch = matchesFilter(wi);
      const anyChildMatch = children.some(c => matchesFilter(c));
      const showParent = !hasFilters || parentMatch || anyChildMatch;
      if (rows[rowIdx]) rows[rowIdx].style.display = showParent ? '' : 'none';
      rowIdx++;
      for (const child of children) {
        const childMatch = !hasFilters || matchesFilter(child);
        const collapsed = _collapsedBacklogParents.has(wi.id);
        if (rows[rowIdx]) rows[rowIdx].style.display = showParent && childMatch && !collapsed ? '' : 'none';
        rowIdx++;
      }
    } else {
      if (rows[rowIdx]) rows[rowIdx].style.display = matchesFilter(wi) ? '' : 'none';
      rowIdx++;
    }
  }
}

// ── Work Item Detail ────────────────────────────────────────────────────
async function viewWorkItem(id) {
  openPopupTab('workitemTabBtn');
  const container = document.getElementById('wiDetail');
  container.innerHTML = '<div class="empty-state"><div class="spinner"></div><div class="empty-state-text">Loading...</div></div>';
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'getRoute', {
      params: {
        id
      }
    }));
    if (!res) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-text">No work item provider installed</div></div>';
      return;
    }
    const wi = await res.json();
    if (wi.error) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-text">${esc(wi.error)}</div></div>`;
      return;
    }
    state.currentWiDetail = wi;
    container.innerHTML = `
      <div class="wi-detail-header">
        <div>
          <div class="wi-detail-id"><span class="board-card-type type-${wi.type.toLowerCase().replace(/\s+/g, '-')}">${wi.type}</span> #${wi.id}</div>
          <div class="wi-detail-title">${esc(wi.title)}</div>
        </div>
        <div class="wi-detail-actions">
          ${wi.webUrl ? (() => {
      const prov = window.Symphonee?.contributions?.activeWorkItemProvider?.();
      const label = prov && prov.label ? 'Open in ' + prov.label : 'Open in provider';
      return `<button class="btn btn-sm" onclick="window.open('${wi.webUrl}','_blank')"><i data-lucide="external-link"></i> ${esc(label)}</button>`;
    })() : ''}
          <button class="btn btn-sm" onclick="closeWorkItemView()" style="color:var(--subtext0);"><i data-lucide="x"></i> Close</button>
        </div>
      </div>
      <div class="wi-detail-fields">
        <div class="wi-field"><div class="wi-field-label">State</div><div class="wi-field-value"><span class="state-badge state-${wi.state.toLowerCase()}">${wi.state}</span></div></div>
        <div class="wi-field"><div class="wi-field-label">Assigned To</div><div class="wi-field-value">${esc(wi.assignedTo) || 'Unassigned'}</div></div>
        <div class="wi-field"><div class="wi-field-label">Priority</div><div class="wi-field-value priority-${wi.priority}">P${wi.priority}</div></div>
        <div class="wi-field"><div class="wi-field-label">Story Points</div><div class="wi-field-value">${wi.storyPoints || wi.effort || '-'}</div></div>
        <div class="wi-field"><div class="wi-field-label">Area Path</div><div class="wi-field-value">${esc(wi.areaPath)}</div></div>
        <div class="wi-field"><div class="wi-field-label">Iteration</div><div class="wi-field-value">${esc(wi.iterationPath)}</div></div>
        <div class="wi-field"><div class="wi-field-label">Created</div><div class="wi-field-value">${formatDate(wi.createdDate)}</div></div>
        <div class="wi-field"><div class="wi-field-label">Changed</div><div class="wi-field-value">${formatDate(wi.changedDate)}</div></div>
      </div>
      ${wi.tags ? `<div class="wi-tags">${wi.tags.split(';').map(t => t.trim()).filter(Boolean).map(t => `<span class="wi-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${wi.description ? `<div class="wi-detail-section"><div class="wi-detail-section-title">Description</div><div class="wi-detail-html">${wi.description}</div></div>` : ''}
      ${wi.acceptanceCriteria ? `<div class="wi-detail-section"><div class="wi-detail-section-title">Acceptance Criteria</div><div class="wi-detail-html">${wi.acceptanceCriteria}</div></div>` : ''}
      ${wi.reproSteps ? `<div class="wi-detail-section"><div class="wi-detail-section-title">Repro Steps</div><div class="wi-detail-html">${wi.reproSteps}</div></div>` : ''}
      ${wi.linkedItems.length > 0 ? `
        <div class="wi-detail-section">
          <div class="wi-detail-section-title">Linked Items</div>
          ${wi.linkedItems.filter(l => l.id).map(l => `
            <div class="wi-linked" onclick="viewWorkItem(${l.id})">
              <span class="wi-linked-id">#${l.id}</span>
              <span class="wi-linked-rel">${formatRelationType(l.rel)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="wi-detail-section">
        <div class="wi-detail-section-title">Discussion</div>
        <div id="wiCommentsList">
          ${wi.comments.length > 0 ? wi.comments.map(c => `
            <div class="wi-comment">
              <span class="wi-comment-author">${esc(c.author)}</span>
              <span class="wi-comment-date">${formatDate(c.date)}</span>
              <div class="wi-comment-body">${c.text}</div>
            </div>
          `).join('') : '<div style="font-size:12px;color:var(--subtext0);padding:8px 0;">No comments yet.</div>'}
        </div>
        <div style="margin-top:10px;display:flex;gap:6px;align-items:center;">
          <input class="pr-comment-input" id="wiCommentInput" type="text" placeholder="Leave a comment..." style="flex:1;">
          <button class="pr-expand-btn" onclick="openWICommentModal(${wi.id})" title="Expand"><i data-lucide="expand" style="width:14px;height:14px;"></i></button>
          <button class="pr-btn pr-btn-comment" onclick="addWIComment(${wi.id})">Comment</button>
        </div>
      </div>
      <div style="margin-top:20px;padding:14px;background:var(--surface0);border-radius:var(--radius-lg);border:1px solid var(--surface1);">
        ${state.configData.Repos && _repoNamesForSpace(state.configData.Repos, window._spacesCache || {}, state.activeSpace).length > 0 ? `
          <div style="display:flex;align-items:center;gap:10px;">
            <select id="startWorkRepo" onchange="selectRepo(this.value)" style="padding:7px 10px;background:var(--base);border:1px solid var(--surface1);border-radius:var(--radius);color:var(--text);font:12px var(--font-ui);outline:none;flex:1;">
              ${_repoNamesForSpace(state.configData.Repos, window._spacesCache || {}, state.activeSpace).map(r => `<option value="${esc(r)}"${r === state.activeRepo ? ' selected' : ''}>${esc(r)}</option>`).join('')}
            </select>
            <button class="btn btn-primary" onclick="startWorking(${wi.id})" style="flex-shrink:0;width:auto;padding:7px 16px;"><i data-lucide="play"></i> Start Working</button>
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:12px;color:var(--subtext0);flex:1;">No repositories configured yet.</span>
            <button class="btn btn-sm" onclick="openSettings()" style="width:auto;flex-shrink:0;"><i data-lucide="settings"></i> Add in Settings</button>
          </div>
        `}
      </div>
    `;
    lucide.createIcons();
    // Attach @mention autocomplete to inline comment input
    attachMention(document.getElementById('wiCommentInput'));
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load work item</div></div>`;
  }
}
function closeWorkItemView() {
  closeWorkItemTab();
}
function closeWorkItemTab() {
  state.currentWiDetail = null;
  closePopupTab('workitemTabBtn');
}

// ── @mention autocomplete ────────────────────────────────────────────
state._mentionCache = null;
state._mentionActiveIdx = -1;
state._mentionTarget = null; // the input/textarea being typed in
state._mentionStart = -1; // caret position of the '@'
async function getMentionMembers() {
  if (state._mentionCache) return state._mentionCache;
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'teamMembersRoute', {}));
    if (!res) {
      state._mentionCache = [];
      return state._mentionCache;
    }
    const data = await res.json();
    if (!data.error) state._mentionCache = data;
    return state._mentionCache || [];
  } catch (_) {
    return [];
  }
}
function mentionSearch(query, members) {
  const q = query.toLowerCase();
  return members.filter(m => m.displayName.toLowerCase().includes(q) || m.uniqueName.toLowerCase().includes(q)).slice(0, 8);
}
function renderMentionDropdown(matches) {
  const dd = document.getElementById('mentionDropdown');
  if (!matches.length) {
    dd.classList.remove('open');
    return;
  }
  state._mentionActiveIdx = 0;
  dd.innerHTML = matches.map((m, i) => `
    <div class="mention-item${i === 0 ? ' active' : ''}" data-idx="${i}" data-name="${esc(m.displayName)}">
      <div class="mention-avatar">${(m.displayName || '?')[0].toUpperCase()}</div>
      <div>
        <div class="mention-name">${esc(m.displayName)}</div>
        <div class="mention-email">${esc(m.uniqueName)}</div>
      </div>
    </div>
  `).join('');
  dd.classList.add('open');

  // Position near the caret
  positionMentionDropdown();

  // Click handler
  dd.querySelectorAll('.mention-item').forEach(item => {
    item.onmousedown = e => {
      e.preventDefault();
      acceptMention(item.dataset.name);
    };
  });
}
function positionMentionDropdown() {
  const dd = document.getElementById('mentionDropdown');
  if (!state._mentionTarget) return;
  const rect = state._mentionTarget.getBoundingClientRect();
  // Place below the input, aligned left
  dd.style.left = rect.left + 'px';
  dd.style.top = rect.bottom + 4 + 'px';
  dd.style.minWidth = Math.min(rect.width, 280) + 'px';
}
function acceptMention(name) {
  if (!state._mentionTarget) return;
  const el = state._mentionTarget;
  const val = el.value;
  const before = val.slice(0, state._mentionStart);
  const after = val.slice(el.selectionStart || state._mentionStart);
  el.value = before + '@' + name + ' ' + after;
  // Move caret after the inserted name
  const newPos = state._mentionStart + name.length + 2; // @name + space
  el.setSelectionRange(newPos, newPos);
  el.focus();
  closeMentionDropdown();
}
function closeMentionDropdown() {
  const dd = document.getElementById('mentionDropdown');
  dd.classList.remove('open');
  state._mentionActiveIdx = -1;
  state._mentionStart = -1;
}
async function handleMentionInput(e) {
  const el = e.target;
  state._mentionTarget = el;
  const val = el.value;
  const caret = el.selectionStart || 0;

  // Find the '@' before the caret with no spaces between @ and caret
  const textBefore = val.slice(0, caret);
  const atIdx = textBefore.lastIndexOf('@');
  if (atIdx < 0) {
    closeMentionDropdown();
    return;
  }

  // The character before @ must be start-of-string, space, or newline
  if (atIdx > 0 && !/[\s\n]/.test(val[atIdx - 1])) {
    closeMentionDropdown();
    return;
  }
  const query = textBefore.slice(atIdx + 1);
  // If query has a space, mention is done
  if (/\s/.test(query)) {
    closeMentionDropdown();
    return;
  }
  state._mentionStart = atIdx;
  const members = await getMentionMembers();
  const matches = query.length === 0 ? members.slice(0, 8) : mentionSearch(query, members);
  renderMentionDropdown(matches);
}
function handleMentionKeydown(e) {
  const dd = document.getElementById('mentionDropdown');
  if (!dd.classList.contains('open')) return;
  const items = dd.querySelectorAll('.mention-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[state._mentionActiveIdx]?.classList.remove('active');
    state._mentionActiveIdx = (state._mentionActiveIdx + 1) % items.length;
    items[state._mentionActiveIdx]?.classList.add('active');
    items[state._mentionActiveIdx]?.scrollIntoView({
      block: 'nearest'
    });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[state._mentionActiveIdx]?.classList.remove('active');
    state._mentionActiveIdx = (state._mentionActiveIdx - 1 + items.length) % items.length;
    items[state._mentionActiveIdx]?.classList.add('active');
    items[state._mentionActiveIdx]?.scrollIntoView({
      block: 'nearest'
    });
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (state._mentionActiveIdx >= 0 && items[state._mentionActiveIdx]) {
      e.preventDefault();
      acceptMention(items[state._mentionActiveIdx].dataset.name);
    }
  } else if (e.key === 'Escape') {
    closeMentionDropdown();
  }
}

// Attach to an input/textarea element
function attachMention(el) {
  if (!el || el._mentionAttached) return;
  el._mentionAttached = true;
  el.addEventListener('input', handleMentionInput);
  el.addEventListener('keydown', handleMentionKeydown);
  el.addEventListener('blur', () => setTimeout(closeMentionDropdown, 200));
}

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.mention-dropdown') && !e.target.closest('#wiCommentInput') && !e.target.closest('#wiCommentModalInput')) {
    closeMentionDropdown();
  }
});
state._wiCommentTargetId = null;
function openWICommentModal(wiId) {
  state._wiCommentTargetId = wiId;
  const inline = document.getElementById('wiCommentInput');
  const modal = document.getElementById('wiCommentModal');
  const textarea = document.getElementById('wiCommentModalInput');
  textarea.value = inline ? inline.value : '';
  modal.classList.add('open');
  const submitBtn = document.getElementById('wiCommentModalSubmit');
  submitBtn.onclick = () => submitWICommentModal();
  attachMention(textarea);
  setTimeout(() => textarea.focus(), 100);
}
function closeWICommentModal() {
  document.getElementById('wiCommentModal').classList.remove('open');
}
async function submitWICommentModal() {
  const textarea = document.getElementById('wiCommentModalInput');
  const text = textarea.value.trim();
  if (!text || !state._wiCommentTargetId) return;
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'commentRoute', {
      params: {
        id: state._wiCommentTargetId
      },
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text
        })
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
    textarea.value = '';
    const inline = document.getElementById('wiCommentInput');
    if (inline) inline.value = '';
    closeWICommentModal();
    toast('Comment added', 'success');
    viewWorkItem(state._wiCommentTargetId);
  } catch (e) {
    toast('Failed to add comment', 'error');
  }
}
async function addWIComment(wiId) {
  const input = document.getElementById('wiCommentInput');
  const text = input.value.trim();
  if (!text) return;
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'commentRoute', {
      params: {
        id: wiId
      },
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text
        })
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
    input.value = '';
    toast('Comment added', 'success');
    viewWorkItem(wiId);
  } catch (e) {
    toast('Failed to add comment', 'error');
  }
}

// ── Start Working ───────────────────────────────────────────────────────
async function startWorking(wiId) {
  const repoSelect = document.getElementById('startWorkRepo');
  if (!repoSelect) return;
  const repoName = repoSelect.value;

  // Sync the sidebar repo selection to match
  if (repoName && repoName !== state.activeRepo) {
    selectRepo(repoName);
  }
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'startWorkingRoute', {
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          workItemId: wiId,
          repoName
        })
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
    toast(`Branch: ${data.branchName}`, 'success');
    switchTab('terminal');

    // Resolve the active workItemProvider's detail route so the AI prompt
    // stays provider-agnostic. Falls back to a bootstrap lookup instruction
    // when no provider is resolvable (should not happen since startWorking
    // already required a provider to succeed).
    const provider = window.Symphonee?.contributions?.activeWorkItemProvider?.();
    const getRouteUrl = provider ? (window.Symphonee.contributions.resolve(provider, 'getRoute') || '').replace(':id', String(wiId)) : '';
    const fetchInstruction = getRouteUrl ? `1. Fetch the full work item details from the active work-item provider at http://127.0.0.1:3800${getRouteUrl}` : `1. Call http://127.0.0.1:3800/api/bootstrap, find the workItemProvider contribution, resolve its getRoute, and fetch work item #${wiId}`;
    const ctx = [`I am starting work on work item #${wiId}.`, `Branch "${data.branchName}" has been created and checked out in "${data.repoPath}".`, ``, `Do the following:`, fetchInstruction, `   This returns: title, type, state, priority, tags, description, acceptance criteria,`, `   repro steps, story points, effort, linked items, attachments, and comments.`, `2. For any linked items (parent or children), fetch their details too so you understand the full scope.`, `3. If there are attachments (especially images), download and view them for visual context.`, `4. Analyze everything and suggest an approach for implementing this work item.`].join('\n');
    const sendCtx = () => setTimeout(() => sendCommand(ctx), 2000);
    if (!aiLaunched) {
      setTimeout(() => {
        launchAi();
        sendCtx();
      }, 500);
    } else {
      sendCtx();
    }
  } catch (e) {
    toast('Failed to start working', 'error');
  }
}

// ── Sprint Card ─────────────────────────────────────────────────────────
function updateSprintCard(iteration) {
  if (!iteration) return;
  const info = document.getElementById('sprintInfo');
  const start = new Date(iteration.startDate);
  const finish = new Date(iteration.finishDate);
  const now = new Date();
  const total = (finish - start) / 86400000;
  const elapsed = (now - start) / 86400000;
  const remaining = Math.max(0, Math.ceil((finish - now) / 86400000));
  const pct = Math.min(100, Math.round(elapsed / total * 100));
  info.innerHTML = `
    <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px;">${esc(iteration.name)}</div>
    <div class="stat-row"><span class="stat-label">Start</span><span class="stat-value">${formatDate(iteration.startDate)}</span></div>
    <div class="stat-row"><span class="stat-label">End</span><span class="stat-value">${formatDate(iteration.finishDate)}</span></div>
    <div class="stat-row"><span class="stat-label">Remaining</span><span class="stat-value">${remaining} days</span></div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div style="font-size:10px;color:var(--subtext0);text-align:right;">${pct}% elapsed</div>
  `;
}

// ── Burndown ────────────────────────────────────────────────────────────
async function loadBurndown(iterationPath) {
  const info = document.getElementById('burndownInfo');
  info.innerHTML = '<div class="spinner" style="margin:10px auto;"></div>';
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'burndownRoute', {
      query: {
        iteration: iterationPath
      }
    }));
    if (!res) {
      info.textContent = 'No work item provider';
      return;
    }
    const data = await res.json();
    if (data.error) {
      info.textContent = data.error;
      return;
    }
    const pct = data.totalPoints > 0 ? Math.round(data.completedPoints / data.totalPoints * 100) : 0;
    info.innerHTML = `
      <div class="stat-row"><span class="stat-label">Total Points</span><span class="stat-value">${data.totalPoints}</span></div>
      <div class="stat-row"><span class="stat-label">Completed</span><span class="stat-value" style="color:var(--green)">${data.completedPoints}</span></div>
      <div class="stat-row"><span class="stat-label">Remaining</span><span class="stat-value" style="color:var(--yellow)">${data.remainingPoints}</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="stat-row"><span class="stat-label">Items</span><span class="stat-value">${data.completedItems}/${data.totalItems}</span></div>
    `;
  } catch (e) {
    info.textContent = 'Failed to load burndown';
  }
}

// ── Velocity ────────────────────────────────────────────────────────────
async function loadVelocity() {
  const info = document.getElementById('velocityInfo');
  info.innerHTML = '<div class="spinner" style="margin:10px auto;"></div>';
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'velocityRoute', {}));
    if (!res) {
      info.textContent = 'No work item provider';
      return;
    }
    const data = await res.json();
    if (data.error) {
      info.textContent = data.error;
      return;
    }
    info.innerHTML = `<div class="stat-row"><span class="stat-label">Average Velocity</span><span class="stat-value">${data.averageVelocity} pts/iteration</span></div>`;
    drawVelocityChart(data.velocity, data.averageVelocity);
  } catch (e) {
    info.textContent = 'Failed to load velocity';
  }
}
function drawVelocityChart(velocity, avg) {
  const canvas = document.getElementById('velocityChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  const pad = {
    top: 20,
    right: 20,
    bottom: 40,
    left: 40
  };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  if (velocity.length === 0) return;
  const maxPts = Math.max(...velocity.map(v => v.completedPoints), avg, 1);
  const barW = Math.min(30, chartW / velocity.length * 0.6);
  const gap = (chartW - barW * velocity.length) / (velocity.length + 1);
  ctx.clearRect(0, 0, w, h);

  // Grid lines
  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const subtextColor = getComputedStyle(document.documentElement).getPropertyValue('--subtext0').trim();
  const surfaceColor = getComputedStyle(document.documentElement).getPropertyValue('--surface0').trim();
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + chartH / 4 * i;
    ctx.strokeStyle = surfaceColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = subtextColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxPts * (1 - i / 4)), pad.left - 6, y + 3);
  }

  // Bars
  velocity.forEach((v, i) => {
    const x = pad.left + gap + i * (barW + gap);
    const barH = v.completedPoints / maxPts * chartH;
    const y = pad.top + chartH - barH;
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
    ctx.fill();

    // Label
    ctx.fillStyle = subtextColor;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    const label = v.iteration.length > 8 ? v.iteration.slice(0, 8) + '..' : v.iteration;
    ctx.fillText(label, x + barW / 2, h - pad.bottom + 14);

    // Value on top
    ctx.fillStyle = accentColor;
    ctx.font = '10px sans-serif';
    ctx.fillText(v.completedPoints, x + barW / 2, y - 4);
  });

  // Average line
  const avgY = pad.top + chartH - avg / maxPts * chartH;
  ctx.strokeStyle = subtextColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, avgY);
  ctx.lineTo(w - pad.right, avgY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = subtextColor;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`avg: ${avg}`, w - pad.right + 4, avgY + 3);
}

// ── Team ────────────────────────────────────────────────────────────────
async function loadTeams() {
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'teamsRoute', {}));
    if (!res) return;
    const teams = await res.json();
    if (teams.error) return;
    const select = document.getElementById('boardTeamSelect');
    select.innerHTML = '';
    const currentTeam = state.configData.DefaultTeam || '';
    for (const t of teams) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      if (t.name === currentTeam) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (_) {}
}
async function switchTeam(teamName) {
  if (!teamName) return;
  // Save to config
  await fetch('/api/config', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      DefaultTeam: teamName
    })
  });
  state.configData.DefaultTeam = teamName;
  // Reset child filters - both Area and Iteration depend on the selected team
  document.getElementById('areaSelect').value = '';
  document.getElementById('sprintSelect').value = '';
  state.closedItemsLimit = 10;
  // Reload everything for the new team
  loadAreas();
  loadIterations();
  loadWorkItems(true);
  loadTeamMembers();
  pushUiContext();
}

// ── Area Paths ──────────────────────────────────────────────────────────
async function loadAreas() {
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'areasRoute', {}));
    if (!res) return;
    const areas = await res.json();
    if (areas.error) return;
    const select = document.getElementById('areaSelect');
    const prev = select.value;
    select.innerHTML = '<option value="">Team Default</option>';
    for (const area of areas) {
      const opt = document.createElement('option');
      opt.value = area;
      // Show indented name: strip project prefix for readability
      const parts = area.split('\\');
      const indent = parts.length > 1 ? '\u00A0\u00A0'.repeat(parts.length - 1) : '';
      opt.textContent = indent + parts[parts.length - 1];
      opt.title = area;
      if (area === prev) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (_) {}
}
function onAreaChange() {
  state.closedItemsLimit = 10;
  loadWorkItems(true);
  pushUiContext();
}
async function loadTeamMembers() {
  const container = document.getElementById('teamList');
  container.innerHTML = '<div class="spinner" style="margin:10px auto;"></div>';
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && (await pf('workItem', 'teamMembersRoute', {}));
    if (!res) {
      container.textContent = 'No work item provider';
      return;
    }
    const data = await res.json();
    if (data.error) {
      container.textContent = data.error;
      return;
    }
    container.innerHTML = data.map(m => `
      <div class="team-member" onclick="filterByUser('${esc(m.displayName)}')" style="cursor:pointer;" title="View ${esc(m.displayName)}'s items">
        <div class="team-avatar">${(m.displayName || '?')[0]}</div>
        <div>
          <div class="team-name">${esc(m.displayName)}</div>
          <div class="team-email">${esc(m.uniqueName)}</div>
        </div>
      </div>
    `).join('');

    // Populate the create modal assign dropdown
    const assignSelect = document.getElementById('createAssign');
    assignSelect.innerHTML = '<option value="">Unassigned</option>';
    for (const m of data) {
      const opt = document.createElement('option');
      opt.value = m.displayName;
      opt.textContent = m.displayName;
      assignSelect.appendChild(opt);
    }
  } catch (e) {
    container.textContent = 'Failed to load team';
  }
}
function filterTeamMembers() {
  const q = document.getElementById('teamSearch').value.toLowerCase();
  document.querySelectorAll('#teamList .team-member').forEach(el => {
    const name = el.querySelector('.team-name')?.textContent.toLowerCase() || '';
    const email = el.querySelector('.team-email')?.textContent.toLowerCase() || '';
    el.style.display = name.includes(q) || email.includes(q) ? '' : 'none';
  });
}

// ── Activity Feed ───────────────────────────────────────────────────────
function updateActivityFeed() {
  const container = document.getElementById('activityFeed');
  const recent = [...state.workItems].sort((a, b) => new Date(b.changedDate) - new Date(a.changedDate)).slice(0, 25);
  if (recent.length === 0) {
    container.innerHTML = '<div style="color:var(--subtext0);font-size:12px;">No recent activity</div>';
    return;
  }

  // Determine activity type based on state and timing
  function activityLabel(wi) {
    const state = wi.state;
    const changed = new Date(wi.changedDate);
    const created = wi.createdDate ? new Date(wi.createdDate) : null;
    const hoursSince = (Date.now() - changed) / 3600000;
    if (state === 'Closed' || state === 'Done') return {
      text: 'Closed',
      color: 'var(--subtext0)',
      icon: 'check-circle'
    };
    if (state === 'Resolved') return {
      text: 'Resolved',
      color: 'var(--mauve)',
      icon: 'check'
    };
    if (state === 'Active') return {
      text: 'In Progress',
      color: 'var(--green)',
      icon: 'play'
    };
    if (state === 'New' && hoursSince < 48) {
      // Only say "Created" if changedDate is within 2 minutes of createdDate (truly new)
      const isRealCreation = created && Math.abs(changed - created) < 120000;
      if (isRealCreation) return {
        text: 'Created',
        color: 'var(--blue)',
        icon: 'plus-circle'
      };
      return {
        text: 'Updated',
        color: 'var(--sapphire)',
        icon: 'edit'
      };
    }
    return {
      text: state,
      color: 'var(--subtext0)',
      icon: 'circle'
    };
  }
  container.innerHTML = recent.map(wi => {
    const act = activityLabel(wi);
    return `
    <div class="activity-item" onclick="viewWorkItem(${wi.id})" style="cursor:pointer;">
      <div class="activity-dot" style="background:${act.color}"></div>
      <div style="flex:1;min-width:0;">
        <div class="activity-text">
          <span style="font-size:10px;font-weight:600;color:${act.color}">${act.text}</span>
          <strong>#${wi.id}</strong> ${esc(wi.title)}
        </div>
        <div class="activity-time">
          ${wi.assignedTo ? `${esc(wi.assignedTo.split(' ')[0])} · ` : ''}${formatDate(wi.changedDate)}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Slash-menu (ComposeSlashMenu) ───────────────────────────────────────
// Typing '/' at the start of a token opens a menu of composer actions:
// send-to-ai, attach-file, navigate-to-view, etc. Each action is a function
// that receives (input, match). Registered commands:
const SLASH_COMMANDS = [{
  slug: 'ask',
  label: 'Ask AI',
  desc: 'Send the rest of the line to the active AI',
  hint: 'Send',
  run: input => {
    const line = (input.value || '').replace(/^\/ask\s*/i, '').trim();
    if (!line) return;
    input.value = '';
    if (typeof askAIFromPalette === 'function') askAIFromPalette(line, {
      from: 'quick-ask'
    });
  }
}, {
  slug: 'goto',
  label: 'Go to view',
  desc: 'Switch tabs: /goto terminal, /goto backlog, /goto notes',
  hint: 'Navigate',
  run: input => {
    const view = (input.value || '').replace(/^\/goto\s*/i, '').trim().toLowerCase();
    if (!view) return;
    input.value = '';
    if (typeof switchTab === 'function') switchTab(view);
  }
}, {
  slug: 'note',
  label: 'Create note',
  desc: 'Open Notes tab with a new note',
  hint: 'Note',
  run: input => {
    input.value = '';
    if (typeof switchTab === 'function') switchTab('notes');
  }
}, {
  slug: 'find',
  label: 'Find',
  desc: 'Enter search-mode: press Enter, then type what to find',
  hint: 'Search',
  run: input => {
    // Two-step flow: activate sticky find-mode and wait for the query.
    if (typeof _cmdPaletteEnterMode === 'function') _cmdPaletteEnterMode('find');else {
      input.value = 'find ';
      input.dispatchEvent(new Event('input'));
    }
  }
}];
function attachSlashMenu(inputEl) {
  if (!inputEl || inputEl._slashWired) return;
  inputEl._slashWired = true;
  const menu = document.getElementById('mentionMenu');
  let activeIdx = 0;
  let items = [];
  let anchorStart = -1;
  const close = () => {
    if (!menu.classList.contains('open')) return;
    if (menu.dataset.mode !== 'slash') return;
    menu.classList.remove('open');
    menu.removeAttribute('data-mode');
    anchorStart = -1;
    items = [];
  };
  const render = () => {
    menu.dataset.mode = 'slash';
    menu.innerHTML = items.map((it, i) => '<div class="mention-item ' + (i === activeIdx ? 'active' : '') + '" data-idx="' + i + '">' + '<span class="mention-ico"><i data-lucide="slash"></i></span>' + '<span class="mention-label">/' + it.slug + '</span>' + '<span class="mention-desc">' + it.hint + '</span>' + '</div>').join('') || '<div class="mention-item" style="color:var(--overlay1);cursor:default;">no matches</div>';
    try {
      lucide.createIcons({
        nodes: [menu]
      });
    } catch (_) {}
    menu.querySelectorAll('.mention-item').forEach(row => {
      row.addEventListener('mousedown', e => {
        e.preventDefault();
        const i = parseInt(row.dataset.idx || '-1', 10);
        if (i >= 0) pick(i);
      });
    });
  };
  const pick = i => {
    const it = items[i];
    if (!it) return close();
    // Replace '/query' with '/slug ' so the user can continue typing args.
    const v = inputEl.value || '';
    const caret = inputEl.selectionStart || v.length;
    const prefix = v.slice(0, anchorStart);
    const suffix = v.slice(caret);
    const insert = '/' + it.slug + ' ';
    inputEl.value = prefix + insert + suffix;
    const newPos = (prefix + insert).length;
    inputEl.setSelectionRange(newPos, newPos);
    close();
    inputEl.focus();
  };
  const refresh = () => {
    const v = inputEl.value || '';
    const caret = inputEl.selectionStart || v.length;
    const slice = v.slice(0, caret);
    // Only trigger at start-of-input (slash menu is line-start only).
    const m = /^\/(\w*)$/.exec(slice);
    if (!m) return close();
    const q = m[1].toLowerCase();
    items = SLASH_COMMANDS.filter(c => !q || c.slug.startsWith(q)).slice(0, 10);
    anchorStart = 0;
    activeIdx = 0;
    const rect = inputEl.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = rect.top - 4 + 'px';
    menu.style.transform = 'translateY(-100%)';
    menu.classList.add('open');
    render();
  };
  inputEl.addEventListener('input', refresh);
  inputEl.addEventListener('keydown', e => {
    if (menu.classList.contains('open') && menu.dataset.mode === 'slash') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = (activeIdx + 1) % Math.max(1, items.length);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = (activeIdx - 1 + items.length) % Math.max(1, items.length);
        render();
      } else if (e.key === 'Tab') {
        if (items.length) {
          e.preventDefault();
          e.stopPropagation();
          pick(activeIdx);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }
    // Enter executes the matched slash command against the current input.
    if (e.key === 'Enter' && !e.shiftKey) {
      const v = (inputEl.value || '').trimStart();
      const m = /^\/(\w+)(?:\s|$)/.exec(v);
      if (m) {
        const cmd = SLASH_COMMANDS.find(c => c.slug === m[1].toLowerCase());
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          close();
          try {
            cmd.run(inputEl);
          } catch (err) {
            console.warn('[slash]', err);
          }
        }
      }
    }
  }, true);
  inputEl.addEventListener('blur', () => setTimeout(close, 120));
}
document.addEventListener('DOMContentLoaded', () => {
  attachSlashMenu(document.getElementById('cmdPaletteInput'));
});

// ── @mention autocomplete ───────────────────────────────────────────────
// Attach to any textarea/input to pop a menu when the user types '@'. The
// menu lists skills and repos; selecting inserts '@skill-slug ' into the
// composer so the agent can read it and fetch the skill body.
state._mentionSkillsCache = null;
async function _mentionSkills() {
  if (state._mentionSkillsCache) return state._mentionSkillsCache;
  try {
    const r = await fetch('/api/skills');
    state._mentionSkillsCache = r.ok ? await r.json() : [];
  } catch (_) {
    state._mentionSkillsCache = [];
  }
  return state._mentionSkillsCache;
}
function _mentionItems(query, repos) {
  const q = (query || '').toLowerCase();
  const out = [];
  (state._mentionSkillsCache || []).forEach(s => {
    if (!q || s.slug.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)) {
      out.push({
        type: 'skill',
        slug: s.slug,
        label: s.slug,
        desc: 'SKILL',
        hint: s.description || ''
      });
    }
  });
  _repoNamesForSpace(repos || {}, window._spacesCache || {}, state.activeSpace).forEach(name => {
    if (!q || name.toLowerCase().includes(q)) {
      out.push({
        type: 'repo',
        slug: name,
        label: name,
        desc: 'REPO'
      });
    }
  });
  return out.slice(0, 10);
}
function attachMentions(inputEl) {
  if (!inputEl || inputEl._mentionsWired) return;
  inputEl._mentionsWired = true;
  const menu = document.getElementById('mentionMenu');
  let activeIdx = 0;
  let items = [];
  let anchorStart = -1;
  let reposCache = null;
  const close = () => {
    menu.classList.remove('open');
    menu.classList.remove('in-palette');
    const palette = inputEl.id === 'cmdPaletteInput' ? inputEl.closest('.cmd-palette') : null;
    if (palette) palette.classList.remove('mention-open');
    anchorStart = -1;
    items = [];
  };
  const getTokenAt = () => {
    const v = inputEl.value || '';
    const caret = inputEl.selectionStart || v.length;
    const slice = v.slice(0, caret);
    const m = /@([A-Za-z0-9_-]*)$/.exec(slice);
    if (!m) return null;
    return {
      start: caret - m[0].length,
      query: m[1]
    };
  };
  const positionMenu = () => {
    // Special-case the command palette: anchor to the palette frame so the
    // menu feels like a native part of the palette (same width, flush with
    // the input) instead of a detached panel floating above it.
    const palette = inputEl.id === 'cmdPaletteInput' ? inputEl.closest('.cmd-palette') : null;
    if (palette) {
      const pr = palette.getBoundingClientRect();
      const ir = inputEl.getBoundingClientRect();
      menu.style.left = pr.left + 'px';
      menu.style.top = ir.bottom + 'px';
      menu.style.width = pr.width + 'px';
      menu.style.minWidth = '';
      menu.style.maxWidth = '';
      menu.style.transform = '';
      menu.classList.add('in-palette');
      return;
    }
    const rect = inputEl.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = rect.top - 4 + 'px';
    menu.style.width = '';
    menu.style.transform = 'translateY(-100%)';
    menu.classList.remove('in-palette');
  };
  const render = () => {
    menu.innerHTML = items.map((it, i) => '<div class="mention-item ' + (i === activeIdx ? 'active' : '') + '" data-idx="' + i + '">' + '<span class="mention-ico"><i data-lucide="' + (it.type === 'skill' ? 'sparkles' : 'git-branch') + '"></i></span>' + '<span class="mention-label">' + it.label + '</span>' + '<span class="mention-desc">' + it.desc + '</span>' + '</div>').join('') || '<div class="mention-item" style="color:var(--overlay1);cursor:default;">no matches</div>';
    try {
      lucide.createIcons({
        nodes: [menu]
      });
    } catch (_) {}
    menu.querySelectorAll('.mention-item').forEach(row => {
      row.addEventListener('mousedown', e => {
        e.preventDefault();
        const i = parseInt(row.dataset.idx || '-1', 10);
        if (i >= 0) pick(i);
      });
    });
  };
  const pick = i => {
    const it = items[i];
    if (!it || anchorStart < 0) return close();
    const v = inputEl.value || '';
    const caret = inputEl.selectionStart || v.length;
    const prefix = v.slice(0, anchorStart);
    const suffix = v.slice(caret);
    const insert = '@' + it.slug + ' ';
    inputEl.value = prefix + insert + suffix;
    const newPos = (prefix + insert).length;
    inputEl.setSelectionRange(newPos, newPos);
    close();
    inputEl.dispatchEvent(new Event('input'));
    inputEl.focus();
  };
  const refresh = async () => {
    const tok = getTokenAt();
    if (!tok) return close();
    if (!reposCache) {
      try {
        reposCache = await fetch('/api/repos').then(r => r.ok ? r.json() : {});
      } catch (_) {
        reposCache = {};
      }
    }
    await _mentionSkills();
    anchorStart = tok.start;
    items = _mentionItems(tok.query, reposCache);
    activeIdx = 0;
    positionMenu();
    menu.classList.add('open');
    const palette = inputEl.id === 'cmdPaletteInput' ? inputEl.closest('.cmd-palette') : null;
    if (palette) palette.classList.add('mention-open');
    render();
  };
  inputEl.addEventListener('input', refresh);
  inputEl.addEventListener('keydown', e => {
    if (!menu.classList.contains('open')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % Math.max(1, items.length);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + items.length) % Math.max(1, items.length);
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (items.length) {
        e.preventDefault();
        e.stopPropagation();
        pick(activeIdx);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }, true);
  inputEl.addEventListener('blur', () => setTimeout(close, 120));
}
// Wire up known composers. (Others can call attachMentions on their own input.)
document.addEventListener('DOMContentLoaded', () => {
  attachMentions(document.getElementById('cmdPaletteInput'));
});// ── In-app browser tab ─────────────────────────────────────────────────
// Uses Electron's <webview> tag so we can render arbitrary URLs inside a
// Symphonee tab. Gracefully degrades to an iframe when webview is unavailable
// (e.g. when the app is loaded in a regular browser for dev).
function _getInappWebview() {
  return document.querySelector('#inappBrowserFrame webview, #inappBrowserFrame iframe');
}
state._inappBrowserZoomFactor = 1;
function _clampInappBrowserZoomFactor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(0.25, Math.round(n * 100) / 100));
}
function _formatInappBrowserZoom(factor) {
  return Math.round(_clampInappBrowserZoomFactor(factor) * 100) + '%';
}
function _syncInappBrowserZoomUi() {
  const label = document.getElementById('inappBrowserZoomValue');
  if (label) label.textContent = _formatInappBrowserZoom(state._inappBrowserZoomFactor);
}
function _applyInappBrowserZoom(view) {
  if (!view) return;
  const factor = _clampInappBrowserZoomFactor(state._inappBrowserZoomFactor);
  const tag = (view.tagName || '').toLowerCase();
  if (tag === 'webview') {
    try {
      view.setZoomFactor(factor);
    } catch (_) {}
  } else {
    view.style.transformOrigin = 'top left';
    if (Math.abs(factor - 1) < 0.001) {
      view.style.removeProperty('transform');
      view.style.removeProperty('width');
      view.style.removeProperty('height');
    } else {
      view.style.transform = `scale(${factor})`;
      view.style.width = `${100 / factor}%`;
      view.style.height = `${100 / factor}%`;
    }
  }
  _syncInappBrowserZoomUi();
}
function inappBrowserSetZoomFactor(nextFactor) {
  state._inappBrowserZoomFactor = _clampInappBrowserZoomFactor(nextFactor);
  _applyInappBrowserZoom(_getInappWebview());
}
function inappBrowserZoomIn() {
  inappBrowserSetZoomFactor(state._inappBrowserZoomFactor + 0.1);
}
function inappBrowserZoomOut() {
  inappBrowserSetZoomFactor(state._inappBrowserZoomFactor - 0.1);
}
function inappBrowserZoomReset() {
  inappBrowserSetZoomFactor(1);
}
function applyInappBrowserAppearance() {
  const view = _getInappWebview();
  if (!view) return;
  view.style.removeProperty('color-scheme');
  if (view.tagName.toLowerCase() !== 'webview') return;
  try {
    view.executeJavaScript(`(function(){
      try {
        var key = '__symphoneeForceLightScheme';
        if (window[key]) return true;
        var originalMatchMedia = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
        if (originalMatchMedia) {
          window.matchMedia = function(query) {
            var q = String(query || '').toLowerCase();
            var result = originalMatchMedia(query);
            if (q.indexOf('prefers-color-scheme') === -1) return result;
            return new Proxy(result, {
              get: function(target, prop) {
                if (prop === 'matches') {
                  if (q.indexOf('light') !== -1) return true;
                  if (q.indexOf('dark') !== -1) return false;
                }
                var value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
              }
            });
          };
        }
        if (document.documentElement && document.documentElement.style) {
          document.documentElement.style.setProperty('color-scheme', 'light', 'important');
        }
        window[key] = true;
        return true;
      } catch (_) {
        return false;
      }
    })();`, true).catch(() => {});
  } catch (_) {}
}
function _shortenBrowserText(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, Math.max(0, maxLen - 3)) + '...';
}
function _clearBrowserSelection() {
  _browserInspectState.selected = null;
  _renderBrowserSelection();
}
function _clearBrowserSelectionAndHighlight() {
  _clearBrowserSelection();
  const view = _getInappWebview();
  if (view && view.tagName.toLowerCase() === 'webview') {
    try {
      view.executeJavaScript("(function(){var k='__symphoneeInspectBridge';if(window[k]&&window[k].clearSelected)window[k].clearSelected();})();", true).catch(() => {});
    } catch (_) {}
  }
}
function _getBrowserAgentInput() {
  return document.getElementById('inappAgentInput');
}
function _autosizeAgentInput(el) {
  const input = el || _getBrowserAgentInput();
  if (!input) return;
  input.style.height = 'auto';
  const max = 220;
  const min = 40;
  input.style.height = Math.max(min, Math.min(input.scrollHeight, max)) + 'px';
}
const _FRIENDLY_TAGS = {
  a: 'link',
  button: 'button',
  img: 'image',
  svg: 'icon',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
  input: 'input',
  textarea: 'text field',
  select: 'dropdown',
  form: 'form',
  label: 'label',
  nav: 'nav',
  header: 'header',
  footer: 'footer',
  main: 'main',
  section: 'section',
  article: 'article',
  aside: 'aside',
  li: 'list item',
  ul: 'list',
  ol: 'list',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'cell',
  video: 'video',
  audio: 'audio',
  iframe: 'frame',
  span: 'text',
  div: 'block'
};
function _friendlySelectionLabel(sel) {
  if (!sel) return '';
  const tag = (sel.tagName || '').toLowerCase();
  const friendly = _FRIENDLY_TAGS[tag] || tag || 'element';
  const attrs = sel.attributes || {};
  const text = sel.text ? _shortenBrowserText(sel.text, 60) : '';
  const label = attrs['aria-label'] || attrs.alt || attrs.title || attrs.placeholder || attrs.name || '';
  if (text) return friendly + ' "' + text + '"';
  if (label) return friendly + ' "' + _shortenBrowserText(label, 60) + '"';
  if (attrs.href) return friendly + ' -> ' + _shortenBrowserText(attrs.href, 50);
  return friendly;
}
function _renderBrowserSelection() {
  const panel = document.getElementById('inappAgentSelection');
  const target = document.getElementById('inappAgentSelectionTarget');
  if (panel && target) {
    const sel = _browserInspectState.selected;
    if (!sel) {
      panel.classList.remove('open');
      target.textContent = '';
    } else {
      panel.classList.add('open');
      target.textContent = _friendlySelectionLabel(sel);
    }
  }
  if (_inappToolsState.open && _inappToolsState.current === 'inspect') {
    try {
      _renderInappCodeInspect();
    } catch (_) {}
  }
}
function _syncInappInspectButton() {
  const btn = document.getElementById('inappInspectBtn');
  if (!btn) return;
  btn.classList.toggle('inspecting', !!_browserInspectState.enabled);
}
function _buildInappInspectScript(enabled) {
  return `(function(){
    var KEY = '__symphoneeInspectBridge';
    var PREFIX = '__SYMPHONEE_INSPECT__';
    function cleanupExisting() {
      if (!window[KEY]) return;
      try { window[KEY].cleanup && window[KEY].cleanup(); } catch (_) {}
      window[KEY] = null;
    }
    function escCss(s) {
      if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
      return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
    }
    function buildSelector(el) {
      if (!el || !el.tagName) return '';
      var parts = [];
      var node = el;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        var part = node.tagName.toLowerCase();
        if (node.id) {
          part += '#' + escCss(node.id);
          parts.unshift(part);
          break;
        }
        var cls = (node.className && typeof node.className === 'string') ? node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
        if (cls.length) part += '.' + cls.map(escCss).join('.');
        var sib = node;
        var index = 1;
        while ((sib = sib.previousElementSibling)) index++;
        part += ':nth-child(' + index + ')';
        parts.unshift(part);
        node = node.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }
    function describe(el) {
      var rect = el.getBoundingClientRect();
      var attrs = {};
      try {
        if (el.attributes) {
          for (var i = 0; i < el.attributes.length; i++) {
            var a = el.attributes[i];
            if (a && a.name) attrs[a.name] = a.value || '';
          }
        }
      } catch (_) {}
      return {
        tagName: (el.tagName || '').toLowerCase(),
        selector: buildSelector(el),
        text: ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 280),
        attributes: attrs,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        url: location.href
      };
    }
    cleanupExisting();
    if (!${enabled ? 'true' : 'false'}) return 'disabled';
    var overlay = document.createElement('div');
    overlay.id = '__symphoneeInspectOverlay';
    overlay.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:2px dashed #078efa;background:rgba(7,142,250,0.10);pointer-events:none;z-index:2147483646;box-sizing:border-box;display:none;';
    document.documentElement.appendChild(overlay);
    var selected = document.createElement('div');
    selected.id = '__symphoneeInspectSelected';
    selected.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:2px solid #f9a03f;background:rgba(249,160,63,0.14);pointer-events:none;z-index:2147483647;box-sizing:border-box;display:none;box-shadow:0 0 0 1px rgba(0,0,0,0.35),0 4px 16px rgba(249,160,63,0.35);border-radius:3px;';
    document.documentElement.appendChild(selected);
    var label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:-1px;top:-22px;padding:2px 8px;font:600 11px system-ui,-apple-system,Segoe UI,sans-serif;color:#1b1b1b;background:#f9a03f;border-radius:3px 3px 0 0;white-space:nowrap;';
    selected.appendChild(label);
    var selectedEl = null;
    function positionSelected() {
      if (!selectedEl || !selectedEl.isConnected) { selected.style.display = 'none'; return; }
      var rect = selectedEl.getBoundingClientRect();
      selected.style.display = 'block';
      selected.style.left = rect.left + 'px';
      selected.style.top = rect.top + 'px';
      selected.style.width = rect.width + 'px';
      selected.style.height = rect.height + 'px';
      label.style.top = rect.top > 24 ? '-22px' : 'auto';
      label.style.bottom = rect.top > 24 ? 'auto' : '-22px';
      label.style.borderRadius = rect.top > 24 ? '3px 3px 0 0' : '0 0 3px 3px';
    }
    function setSelected(el) {
      selectedEl = el;
      var tag = (el.tagName || '').toLowerCase();
      var text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      label.textContent = text ? (tag + ' · ' + text) : tag;
      positionSelected();
    }
    function highlight(el) {
      if (!el || !el.getBoundingClientRect) return;
      var rect = el.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = rect.left + 'px';
      overlay.style.top = rect.top + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';
    }
    function onMove(ev) {
      if (!ev.target || ev.target === overlay || ev.target === selected || ev.target === document.documentElement || ev.target === document.body) return;
      highlight(ev.target);
    }
    function onClick(ev) {
      if (!ev.target || ev.target === overlay || ev.target === selected) return;
      highlight(ev.target);
      setSelected(ev.target);
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      console.info(PREFIX + JSON.stringify(describe(ev.target)));
      return false;
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', positionSelected, true);
    window.addEventListener('resize', positionSelected, true);
    window[KEY] = {
      cleanup: function() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        window.removeEventListener('scroll', positionSelected, true);
        window.removeEventListener('resize', positionSelected, true);
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (selected && selected.parentNode) selected.parentNode.removeChild(selected);
      },
      clearSelected: function() { selectedEl = null; selected.style.display = 'none'; }
    };
    return 'enabled';
  })();`;
}
function _applyInappInspectMode(view) {
  const targetView = view || _getInappWebview();
  if (!targetView || targetView.tagName.toLowerCase() !== 'webview') return;
  try {
    targetView.executeJavaScript(_buildInappInspectScript(_browserInspectState.enabled), true).catch(() => {});
  } catch (_) {}
}
function _ensureBrowserAgentPanelOpen() {
  const panel = document.getElementById('inappAgentPanel');
  const chip = document.getElementById('inappAgentChip');
  if (!panel || panel.classList.contains('open')) return;
  panel.classList.add('open');
  _browserAgentState.open = true;
  if (chip) chip.classList.add('active');
  _loadBrowserAgentStatus();
}
function _handleInappBrowserConsoleMessage(message) {
  const text = String(message || '');
  const keyPrefix = '__SYMPHONEE_KEY__';
  if (text.startsWith(keyPrefix)) {
    try {
      _dispatchForwardedKey(JSON.parse(text.slice(keyPrefix.length)));
    } catch (_) {}
    return;
  }
  const prefix = '__SYMPHONEE_INSPECT__';
  if (!text.startsWith(prefix)) return;
  try {
    _browserInspectState.selected = JSON.parse(text.slice(prefix.length));
    _renderBrowserSelection();
    const inspectToolActive = _inappToolsState.open && _inappToolsState.current === 'inspect';
    if (!inspectToolActive) {
      _ensureBrowserAgentPanelOpen();
      const input = _getBrowserAgentInput();
      if (input) {
        input.focus();
        try {
          input.setSelectionRange(input.value.length, input.value.length);
        } catch (_) {}
      }
    }
    // One-shot capture: turn the picker off after a target lands so the user
    // must reopen Tools > Select / Inspect code to grab another element.
    // We disarm inline (not via toggleInappInspectMode, which would also
    // wipe _browserInspectState.selected and blank the Inspect code panel).
    if (_browserInspectState.enabled) {
      _browserInspectState.enabled = false;
      _syncInappInspectButton();
      const view = _ensureInappBrowser();
      if (view) {
        try {
          _applyInappInspectMode(view);
        } catch (_) {}
      }
      if (_inappToolsState.open && _inappToolsState.current === 'menu') {
        try {
          _renderInappToolsMenu();
        } catch (_) {}
      }
    }
  } catch (_) {}
}
// Handle a shortcut forwarded from inside the webview via console.info.
function _dispatchForwardedKey(payload) {
  if (!payload || typeof payload.key !== 'string') return;
  const k = payload.key;
  const shift = !!payload.shift;
  const ctrl = !!payload.ctrl;
  if (ctrl && (k === 'k' || k === 'K')) {
    openCmdPalette();
    return;
  }
  if (k === 'Escape') {
    if (state._inspectIsEditing) {
      _inspectToggleEdit();
      return;
    }
    if (state._colorPopoverEl) {
      _closeColorPopover();
      return;
    }
    const overlay = document.getElementById('symShortcutsOverlay');
    if (overlay && overlay.classList.contains('open')) {
      hideInappShortcutsHelp();
      return;
    }
    if (_inappToolsState.open) {
      closeInappToolsPanel();
      return;
    }
    if (_browserAgentState.open) {
      toggleBrowserAgentPanel();
      return;
    }
    if (_browserInspectState.enabled) {
      toggleInappInspectMode(false);
      return;
    }
    return;
  }
  if (k === '?' || k === '/' && shift) {
    showInappShortcutsHelp();
    return;
  }
  const low = k.toLowerCase();
  if (low === 'i') {
    toggleInappInspectMode();
    return;
  }
  if (low === 'h') {
    if (shift) {
      _ensureSymKit().then(() => _symKitCall('unhideAll'));
      toast('Un-hid all', 'info', {
        duration: 1000
      });
    } else if (state._inspectActiveSelector) _inspectHideSelected();
    return;
  }
  if (low === 'g') {
    toggleInappGrayscale();
    return;
  }
  if (low === 'f') {
    toggleInappFocusMode();
    return;
  }
  if (low === 't') {
    toggleInappToolsPanelMenu();
    return;
  }
  if (low === 'e') {
    _inspectToggleEdit();
    return;
  }
}
function toggleInappInspectMode(forceState) {
  const nextState = typeof forceState === 'boolean' ? forceState : !_browserInspectState.enabled;
  _browserInspectState.enabled = !!nextState;
  if (!_browserInspectState.enabled) _clearBrowserSelection();
  _syncInappInspectButton();
  const view = _ensureInappBrowser();
  if (view) _applyInappInspectMode(view);
  toast(_browserInspectState.enabled ? 'Inspect mode is on. Click an element in the page to select it.' : 'Inspect mode is off.', 'info', {
    duration: 2600
  });
}
function _ensureInappBrowser(initialUrl) {
  const frame = document.getElementById('inappBrowserFrame');
  if (!frame) return null;
  let view = _getInappWebview();
  if (view) return view;
  const supportsWebview = typeof customElements !== 'undefined' && !!customElements.get('webview');
  // Electron exposes webview as an HTML tag; createElement('webview') works.
  const tag = supportsWebview ? 'webview' : 'iframe';
  view = document.createElement(tag);
  view.setAttribute('src', initialUrl || 'https://duckduckgo.com/');
  view.setAttribute('allowpopups', '');
  view.setAttribute('style', 'flex:1;width:100%;height:100%;border:0;background:#fff;');
  if (tag === 'webview') {
    view.addEventListener('dom-ready', () => {
      applyInappBrowserAppearance();
      if (_browserInspectState.enabled) _applyInappInspectMode(view);
      _applyInappBrowserZoom(view);
    });
    view.addEventListener('did-navigate', e => {
      _syncInappUrl(e.url);
      _clearBrowserSelection();
      _resetOverlayStateForNewPage();
      try {
        _pageMapCache.url = '';
        _pageMapCache.map = null;
      } catch (_) {}
    });
    view.addEventListener('did-navigate-in-page', e => {
      _syncInappUrl(e.url);
      _clearBrowserSelection();
      _resetOverlayStateForNewPage();
      try {
        _pageMapCache.url = '';
        _pageMapCache.map = null;
      } catch (_) {}
    });
    view.addEventListener('page-title-updated', () => {/* could update tab title */});
    view.addEventListener('console-message', e => _handleInappBrowserConsoleMessage(e && e.message));
  } else {
    view.addEventListener('load', () => {
      try {
        _syncInappUrl(view.contentWindow.location.href);
      } catch (_) {}
      _applyInappBrowserZoom(view);
    });
  }
  frame.innerHTML = '';
  frame.appendChild(view);
  applyInappBrowserAppearance();
  _applyInappBrowserZoom(view);
  return view;
}
function _syncInappUrl(url) {
  const input = document.getElementById('inappBrowserUrl');
  if (input && url) input.value = url;
}
function _normalizeInappUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'https://duckduckgo.com/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}
function inappBrowserGo() {
  const input = document.getElementById('inappBrowserUrl');
  if (!input) return;
  const url = _normalizeInappUrl(input.value);
  const view = _ensureInappBrowser(url);
  if (!view) return;
  if (view.tagName.toLowerCase() === 'webview') {
    try {
      view.loadURL(url);
    } catch (_) {
      view.src = url;
    }
  } else {
    view.src = url;
  }
  applyInappBrowserAppearance();
  input.value = url;
}
function inappBrowserBack() {
  const v = _getInappWebview();
  if (!v) return;
  if (v.tagName.toLowerCase() === 'webview') {
    try {
      v.goBack();
    } catch (_) {}
  } else {
    try {
      v.contentWindow.history.back();
    } catch (_) {}
  }
}
function inappBrowserForward() {
  const v = _getInappWebview();
  if (!v) return;
  if (v.tagName.toLowerCase() === 'webview') {
    try {
      v.goForward();
    } catch (_) {}
  } else {
    try {
      v.contentWindow.history.forward();
    } catch (_) {}
  }
}
function inappBrowserReload() {
  const v = _getInappWebview();
  if (!v) return;
  if (v.tagName.toLowerCase() === 'webview') {
    try {
      v.reload();
    } catch (_) {}
  } else {
    try {
      v.contentWindow.location.reload();
    } catch (_) {}
  }
}
function inappBrowserOpenExternal() {
  const input = document.getElementById('inappBrowserUrl');
  const url = input && input.value ? input.value : 'https://duckduckgo.com/';
  try {
    window.open(url, '_blank');
  } catch (_) {}
}
// Open the browser tab (used by command palette / playwright automation).
function openBrowserTab(initialUrl) {
  const btn = document.getElementById('browserTabBtn');
  if (btn) {
    btn.style.removeProperty('display');
    btn.removeAttribute('hidden');
  }
  switchTab('browser');
  if (initialUrl) {
    const input = document.getElementById('inappBrowserUrl');
    if (input) input.value = initialUrl;
    setTimeout(() => {
      try {
        inappBrowserGo();
      } catch (_) {}
    }, 50);
  }
}
// Hide the browser tab. If it was active, fall back to terminal.
function closeBrowserTab() {
  const btn = document.getElementById('browserTabBtn');
  if (!btn) return;
  const wasActive = btn.classList.contains('active');
  btn.style.display = 'none';
  if (wasActive) switchTab('terminal');
}// ── Apps tab (desktop control) ────────────────────────────────────────────
// Talks to /api/apps/* and listens for WS `apps-agent-step` frames so the
// user sees a live screenshot of the target window in the middle and a
// rationale-paired action log on the right.
var _appsState = {
  sessionId: null,
  running: false,
  hwnd: null,
  title: null,
  app: null,
  windows: [],
  lastRationale: null,
  // buffered text from the most recent message/token
  rationaleEl: null,
  // DOM node so token deltas can append in place
  providerKey: null,
  // provider REGISTRY KEY (anthropic, gemini-live, ...) sent on session/start
  providerLabel: null,
  // human label displayed in the log header; set from server response
  providers: [],
  // list of { key, label, defaultModel } from /api/apps/status
  pendingLaunchSpec: null,
  // {id, path, name} when user picked an app that isn't running yet
  selectedRecipeId: null,
  // id of an Automation to run instead of a free-form chat goal
  selectedRecipeName: null,
  recipes: [] // cached list for the current app
};
function _appsProviderStorageKey() {
  return 'symphonee-apps-provider-v1';
}
function _appsLoadSavedProvider() {
  try {
    return localStorage.getItem(_appsProviderStorageKey()) || null;
  } catch (_) {
    return null;
  }
}
function _appsSaveProvider(key) {
  try {
    localStorage.setItem(_appsProviderStorageKey(), key || '');
  } catch (_) {}
}
async function _appsOnProviderChange() {
  const sel = document.getElementById('appsProviderSelect');
  if (!sel) return;
  _appsState.providerKey = sel.value || null;
  _appsSaveProvider(_appsState.providerKey);
  // Point of need: if they pick the local model and it isn't installed yet, offer
  // to install it now (instead of a cryptic failure when the session starts).
  const p = (_appsState.providers || []).find((x) => x.key === _appsState.providerKey);
  if (p && (p.local || p.key === 'gemma') && typeof symphEnsureLocalModel === 'function') {
    const ok = await symphEnsureLocalModel({ reason: 'Driving desktop apps with the local model' });
    if (!ok) {
      // Declined -- fall back to a cloud provider so they aren't left on a
      // local option that can't run.
      const fallback = (_appsState.providers || []).find((x) => !x.local && x.key !== 'gemma');
      if (fallback) { sel.value = fallback.key; _appsState.providerKey = fallback.key; _appsSaveProvider(fallback.key); }
    }
  }
}
async function _appsRefreshProviders() {
  try {
    const r = await fetch('/api/apps/status');
    const data = await r.json();
    const providers = Array.isArray(data.providers) ? data.providers : [];
    _appsState.providers = providers;
    const sel = document.getElementById('appsProviderSelect');
    if (!sel) return;
    const existingConfigBtn = document.getElementById('appsConfigureKeysBtn');
    if (!providers.length) {
      sel.style.display = 'none';
      _appsState.providerKey = null;
      if (!existingConfigBtn) {
        const btn = document.createElement('button');
        btn.id = 'appsConfigureKeysBtn';
        btn.type = 'button';
        btn.className = 'sy-btn sy-btn-outline';
        btn.style.height = '32px';
        btn.title = 'Open AI settings to add an API key';
        btn.innerHTML = '<i data-lucide="key" style="width:13px;height:13px;"></i> Configure API Keys';
        btn.onclick = () => {
          if (typeof openSettings === 'function') openSettings('ai');
        };
        sel.parentNode.insertBefore(btn, sel);
        if (typeof lucide !== 'undefined') lucide.createIcons({
          el: btn
        });
      }
      return;
    }
    if (existingConfigBtn) existingConfigBtn.remove();
    sel.style.removeProperty('display');
    sel.disabled = false;
    const saved = _appsState.providerKey || _appsLoadSavedProvider();
    const pick = providers.find(p => p.key === saved) || providers.find(p => p.key === 'anthropic') || providers[0];
    _appsState.providerKey = pick.key;
    sel.innerHTML = providers.map(p => `<option value="${p.key}"${p.key === pick.key ? ' selected' : ''}>${p.label}${p.defaultModel ? ' - ' + p.defaultModel : ''}</option>`).join('');
  } catch (_) {}
}
function _appsEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
var _appsLauncher = {
  section: 'running',
  installed: [],
  installedLoadedAt: 0,
  iconCache: {},
  // key → data URL, populated lazily
  iconPending: {} // key → Promise, avoids double-fetch
};
function _appsManualKey() {
  return 'symphonee-apps-manual-v1';
}
function _appsLoadManual() {
  try {
    return JSON.parse(localStorage.getItem(_appsManualKey()) || '[]') || [];
  } catch (_) {
    return [];
  }
}
function _appsSaveManual(list) {
  try {
    localStorage.setItem(_appsManualKey(), JSON.stringify(list));
  } catch (_) {}
}
async function appsRefreshAll() {
  await Promise.all([appsRefreshWindows(), appsRefreshInstalled(), _appsRefreshProviders()]);
  if (!document.getElementById('appsLauncher').hidden) appsRenderLauncher();
}
async function appsRefreshWindows() {
  try {
    const r = await fetch('/api/apps/windows', {
      method: 'POST'
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'listWindows failed');
    _appsState.windows = data.windows || [];
  } catch (e) {
    if (typeof toast === 'function') toast('Apps: ' + e.message, 'error');
  }
}
async function appsRefreshInstalled({
  force = false
} = {}) {
  // Skip refetch within 60s unless explicitly asked.
  if (!force && _appsLauncher.installed.length && Date.now() - _appsLauncher.installedLoadedAt < 60000) return;
  try {
    const r = await fetch('/api/apps/installed', {
      method: 'POST'
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'listInstalled failed');
    _appsLauncher.installed = data.apps || [];
    _appsLauncher.installedLoadedAt = Date.now();
  } catch (e) {
    if (typeof toast === 'function') toast('Apps: ' + e.message, 'error');
  }
}
function _appsSetSelected({
  hwnd,
  title,
  app,
  pendingLaunch
}) {
  _appsState.hwnd = hwnd || null;
  _appsState.title = title || null;
  _appsState.app = app || null;
  const label = document.getElementById('appsPickerLabel');
  if (label) {
    if (pendingLaunch) label.textContent = 'Launching ' + (app || title || 'app') + '...';else if (title || app) label.textContent = (app ? app + ' - ' : '') + (title || '');else label.textContent = 'Pick an app...';
  }
  const insBtn = document.getElementById('appsInstructionsBtn');
  if (insBtn) insBtn.style.display = _appsState.app ? '' : 'none';
  const autoBtn = document.getElementById('appsAutomationsBtn');
  if (autoBtn) autoBtn.style.display = _appsState.app ? '' : 'none';
}
function _appsInstructionsKey() {
  return _appsState.app || (_appsState.title || '').split(/\s[-–]\s/)[0] || '';
}
async function appsOpenInstructions() {
  const app = _appsInstructionsKey();
  if (!app) {
    if (typeof toast === 'function') toast('Pick an app first.', 'warning');
    return;
  }
  _appsPromoteModalToTab('appsInstructionsModal', 'panel-apps-instructions');
  const btn = document.getElementById('appsInstructionsTabBtn');
  const lbl = document.getElementById('appsInstructionsTabLabel');
  if (lbl) lbl.textContent = 'Instructions - ' + app;
  if (btn) {
    _placeTabAtEnd(btn);
    btn.style.display = '';
  }
  switchTab('apps-instructions');
  const nameEl = document.getElementById('appsInstructionsAppName');
  const textEl = document.getElementById('appsInstructionsText');
  const metaEl = document.getElementById('appsInstructionsMeta');
  const statusEl = document.getElementById('appsInstructionsStatus');
  if (nameEl) nameEl.textContent = app;
  if (textEl) {
    textEl.value = 'Loading...';
    textEl.disabled = true;
  }
  if (statusEl) statusEl.textContent = '';
  const panel = document.getElementById('panel-apps-instructions');
  if (panel && typeof lucide !== 'undefined') lucide.createIcons({
    el: panel
  });
  try {
    const r = await fetch('/api/apps/memory?app=' + encodeURIComponent(app));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Load failed');
    if (textEl) {
      textEl.value = data.body || '';
      textEl.disabled = false;
      textEl.focus();
    }
    if (metaEl) metaEl.textContent = data.app || app;
  } catch (e) {
    if (textEl) {
      textEl.value = '';
      textEl.disabled = false;
    }
    if (statusEl) statusEl.textContent = 'Load failed: ' + e.message;
  }
}
function appsCloseInstructions() {
  const btn = document.getElementById('appsInstructionsTabBtn');
  if (btn) btn.style.display = 'none';
  switchTab('apps');
}
async function appsSaveInstructions() {
  const app = _appsInstructionsKey();
  if (!app) return;
  const textEl = document.getElementById('appsInstructionsText');
  const statusEl = document.getElementById('appsInstructionsStatus');
  const body = textEl?.value || '';
  if (statusEl) statusEl.textContent = 'Saving...';
  try {
    // Replace the entire memory file with the textarea contents. The UI
    // loads the full file, so saving should persist the full file — that's
    // how the user can prune duplicate failure bullets from prior sessions.
    const r = await fetch('/api/apps/memory', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        app,
        body,
        mode: 'replace-all'
      })
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'save failed');
    if (statusEl) statusEl.textContent = 'Saved · ' + (data.bytes || 0) + ' bytes';
    setTimeout(() => appsOpenInstructions(), 150);
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Save failed: ' + e.message;
  }
}
function appsExportInstructions() {
  const app = _appsInstructionsKey();
  if (!app) return;
  const textEl = document.getElementById('appsInstructionsText');
  const body = textEl?.value || '';
  if (!body.trim()) {
    if (typeof toast === 'function') toast('Nothing to export — memory is empty.', 'info');
    return;
  }
  // Build a data URL and trigger a download via a temporary <a>. The file
  // contents are whatever is currently in the textarea, so the user can
  // export edits they haven't saved yet too.
  const blob = new Blob([body], {
    type: 'text/markdown;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (app || 'app').replace(/[^a-z0-9_-]+/gi, '-') + '-instructions.md';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 200);
  const statusEl = document.getElementById('appsInstructionsStatus');
  if (statusEl) statusEl.textContent = 'Exported ' + a.download;
}
function appsImportInstructionsTrigger() {
  const f = document.getElementById('appsInstructionsFile');
  if (f) f.click();
}
async function appsClearInstructions() {
  const app = _appsInstructionsKey();
  if (!app) return;
  const ok = await confirmDialog('Wipe all memory for "' + app + '"?\n\n' + 'This removes every learning, DO, DON\'T, and note the agent has saved for this app. ' + 'Useful when old sessions poisoned the file with duplicates. User-written Instructions are also cleared.', {
    confirmText: 'Yes, clear',
    cancelText: 'Cancel',
    danger: true
  });
  if (!ok) return;
  const statusEl = document.getElementById('appsInstructionsStatus');
  const textEl = document.getElementById('appsInstructionsText');
  if (statusEl) statusEl.textContent = 'Clearing...';
  try {
    const r = await fetch('/api/apps/memory', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        app,
        mode: 'clear'
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || 'clear failed (' + r.status + ')');
    // Re-fetch the freshly-cleared file so the textarea reflects reality
    // instead of whatever the user had open before the wipe.
    const r2 = await fetch('/api/apps/memory?app=' + encodeURIComponent(app));
    const d2 = await r2.json().catch(() => ({}));
    if (textEl) textEl.value = d2.body || '';
    if (statusEl) statusEl.textContent = 'Cleared.';
    if (typeof toast === 'function') toast('Instructions cleared for ' + app, 'success', {
      duration: 2000
    });
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Clear failed: ' + e.message;
    if (typeof toast === 'function') toast('Clear failed: ' + e.message, 'error');
  }
}
function appsImportInstructionsFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const textEl = document.getElementById('appsInstructionsText');
    if (!textEl) return;
    const existing = textEl.value.trim();
    const imported = String(reader.result || '').trim();
    if (!imported) return;
    textEl.value = existing ? existing + '\n\n<!-- imported from ' + file.name + ' -->\n' + imported : imported;
    const statusEl = document.getElementById('appsInstructionsStatus');
    if (statusEl) statusEl.textContent = 'Imported ' + file.name + ' — review and hit Save.';
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ═══ Automations ═════════════════════════════════════════════════════════
const _appsAutomations = {
  current: null,
  dirty: false
};
async function appsAutomationsGenerate() {
  const desc = (document.getElementById('appsAutomationsGenInput').value || '').trim();
  const statusEl = document.getElementById('appsAutomationsStatus');
  if (!desc) {
    if (statusEl) statusEl.textContent = 'Describe what you want first.';
    return;
  }
  const btn = document.getElementById('appsAutomationsGenBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating...';
  }
  if (statusEl) statusEl.textContent = 'Asking AI...';
  try {
    const payload = {
      description: desc,
      app: _appsAutomationsApp()
    };
    const modelSel = document.getElementById('appsAutomationsGenModel');
    if (modelSel && modelSel.value) {
      payload.model = modelSel.value;
      const opt = modelSel.selectedOptions && modelSel.selectedOptions[0];
      if (opt && opt.dataset.provider) payload.provider = opt.dataset.provider;
    }
    if (document.getElementById('appsAutomationsGenUseShot').checked && _appsState.hwnd) {
      // Grab a fresh screenshot so AI can ground step descriptions in the
      // actual UI. Uses the apps screenshot route.
      const sr = await fetch('/api/apps/screenshot?hwnd=' + encodeURIComponent(_appsState.hwnd)).catch(() => null);
      if (sr && sr.ok) {
        const sd = await sr.json().catch(() => null);
        if (sd && sd.base64) {
          payload.screenshotBase64 = sd.base64;
          payload.mimeType = sd.mimeType || 'image/jpeg';
        }
      }
    }
    const r = await fetch('/api/apps/recipes/generate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'generate failed');
    const draft = data.draft || {};
    const nameEl = document.getElementById('appsAutomationsName');
    const descEl = document.getElementById('appsAutomationsDesc');
    if (nameEl && !nameEl.value && draft.name) nameEl.value = draft.name;
    if (descEl && !descEl.value && draft.description) descEl.value = draft.description;
    state._appsBuilderSteps = Array.isArray(draft.steps) ? draft.steps : [];
    // Surface the generated steps in both views.
    document.getElementById('appsAutomationsSteps').value = _appsStepsToText(state._appsBuilderSteps);
    if (typeof _appsRenderBuilderRows === 'function') _appsRenderBuilderRows();
    if (statusEl) statusEl.textContent = 'Generated ' + state._appsBuilderSteps.length + ' step' + (state._appsBuilderSteps.length === 1 ? '' : 's') + '. Review and Save.';
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Generate failed: ' + e.message;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="wand-2" style="width:11px;height:11px;"></i> Generate steps';
      if (typeof lucide !== 'undefined') lucide.createIcons({
        el: btn
      });
    }
  }
}

// Recorder UI state. _appsRecording holds { recordingId, captureRect, hwnd }
// while a capture is live; null otherwise. Starting a recording requires a
// picked window (hwnd) so the recorder can filter input to that window only.
state._appsRecording = null;
function _appsRecordSetButton(running) {
  const btn = document.getElementById('appsAutomationsRecordBtn');
  const lbl = document.getElementById('appsAutomationsRecordLabel');
  if (!btn || !lbl) return;
  if (running) {
    btn.classList.add('sy-btn-danger');
    btn.classList.remove('sy-btn-outline');
    btn.style.background = 'color-mix(in srgb, var(--red, #e06c75) 18%, transparent)';
    btn.style.borderColor = 'var(--red, #e06c75)';
    lbl.textContent = 'Stop recording';
  } else {
    btn.classList.remove('sy-btn-danger');
    btn.classList.add('sy-btn-outline');
    btn.style.background = '';
    btn.style.borderColor = '';
    lbl.textContent = 'Record actions';
  }
}
async function appsAutomationsToggleRecord() {
  if (state._appsRecording) return appsAutomationsStopRecording();
  return appsAutomationsStartRecording();
}

// Resolve a usable hwnd without forcing the user back to the Automation tab.
// Preference order:
//   1. The hwnd already bound to the session (they DID pick one).
//   2. A running window whose process/title matches the editor's app name.
//   3. Null - surfaced to the caller so they can launch or pick.
// Best-effort maximize of the resolved hwnd. Automation runs reliably when
// the target app is full-screen; we do this before Record / Pick / Run now
// so recorded coords and replay coords match, and UIA elements aren't cut
// off by the window border.
async function _appsMaximizeHwnd(hwnd) {
  if (!hwnd) return;
  try {
    const r = await fetch('/api/apps/window/maximize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        hwnd
      })
    }).catch(() => null);
    const data = r ? await r.json().catch(() => null) : null;
    // Skip the settle pause when the window was already maximized - saves
    // 180ms on every Record / Pick / Run click in the common case.
    if (!(data && data.alreadyMaximized)) {
      await new Promise(r2 => setTimeout(r2, 180));
    }
  } catch (_) {}
}
async function _appsResolveHwndForRecording() {
  if (_appsState.hwnd) return {
    hwnd: _appsState.hwnd,
    source: 'session'
  };
  const app = (_appsAutomationsApp() || '').toString().trim().toLowerCase();
  if (!app) return {
    hwnd: null,
    reason: 'no app selected'
  };
  const findMatch = wins => {
    const byProc = wins.find(w => (w.processName || '').toLowerCase().startsWith(app));
    const byTitle = wins.find(w => (w.title || '').toLowerCase().includes(app));
    return byProc || byTitle || null;
  };
  try {
    const r = await fetch('/api/apps/windows', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: '{}'
    });
    const data = await r.json();
    const win = findMatch(data && data.windows || []);
    if (win) return {
      hwnd: win.hwnd,
      source: 'lookup',
      title: win.title
    };
  } catch (e) {
    return {
      hwnd: null,
      reason: e.message
    };
  }
  // Not running - find the installed entry and auto-launch. Better UX than
  // asking the user to tab away and start the app manually every time.
  let launchSpec = null;
  try {
    const r = await fetch('/api/apps/installed', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: '{}'
    });
    const data = await r.json();
    const installed = data && data.apps || [];
    launchSpec = installed.find(a => (a.name || '').toLowerCase() === app) || installed.find(a => (a.name || '').toLowerCase().startsWith(app)) || installed.find(a => (a.name || '').toLowerCase().includes(app));
  } catch (_) {}
  if (!launchSpec) {
    return {
      hwnd: null,
      reason: 'no installed app matches "' + app + '" - install it, or pick a window on the Automation tab'
    };
  }
  const statusEl = document.getElementById('appsAutomationsStatus');
  if (statusEl) statusEl.textContent = 'Launching "' + (launchSpec.name || app) + '"...';
  if (typeof toast === 'function') toast('Launching ' + (launchSpec.name || app) + '...', 'info', {
    duration: 2500
  });
  try {
    await fetch('/api/apps/launch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        id: launchSpec.id,
        path: launchSpec.path,
        name: launchSpec.name
      })
    });
  } catch (e) {
    return {
      hwnd: null,
      reason: 'launch failed: ' + e.message
    };
  }
  // Poll for the window to appear. Cold-start is 1-3s for native apps, but
  // Electron/heavy suites can take 10+. Cap at 15s before giving up.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 600));
    try {
      const r2 = await fetch('/api/apps/windows', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: '{}'
      });
      const data2 = await r2.json();
      const win2 = findMatch(data2 && data2.windows || []);
      if (win2) {
        if (statusEl) statusEl.textContent = 'Launched "' + (launchSpec.name || app) + '".';
        return {
          hwnd: win2.hwnd,
          source: 'launched',
          title: win2.title
        };
      }
    } catch (_) {}
  }
  return {
    hwnd: null,
    reason: 'launched but window did not appear within 15s - try again once it\'s visible'
  };
}
async function appsAutomationsStartRecording() {
  const statusEl = document.getElementById('appsAutomationsStatus');
  if (statusEl) statusEl.textContent = 'Starting recorder...';
  const resolved = await _appsResolveHwndForRecording();
  if (!resolved.hwnd) {
    const msg = 'Record needs a running window for "' + (_appsAutomationsApp() || 'this app') + '". ' + (resolved.reason === 'window not found (launch the app first)' ? 'Launch the app from the Automation tab, then try again.' : resolved.reason || 'Pick a window on the Automation tab first.');
    if (statusEl) statusEl.textContent = msg;
    if (typeof toast === 'function') toast(msg, 'warning');
    return;
  }
  // Stick the resolved hwnd on the global session state so the rest of the
  // editor (Run, Stop, chat continuity) sees it too.
  _appsState.hwnd = resolved.hwnd;
  await _appsMaximizeHwnd(resolved.hwnd);
  try {
    const r = await fetch('/api/apps/recording/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        hwnd: resolved.hwnd
      })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'start failed');
    state._appsRecording = {
      recordingId: data.recordingId,
      captureRect: data.captureRect,
      hwnd: _appsState.hwnd
    };
    _appsRecordSetButton(true);
    if (statusEl) statusEl.textContent = 'Recording. Stop with Ctrl+Shift+Q, or click Stop. Input to other windows is ignored.';
    if (typeof toast === 'function') toast('Recording started. Ctrl+Shift+Q to stop.', 'info', {
      duration: 3500
    });
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Record failed: ' + e.message;
    if (typeof toast === 'function') toast('Record failed: ' + e.message, 'error');
  }
}
async function appsAutomationsStopRecording() {
  if (!state._appsRecording) return;
  const rec = state._appsRecording;
  state._appsRecording = null;
  _appsRecordSetButton(false);
  const statusEl = document.getElementById('appsAutomationsStatus');
  if (statusEl) statusEl.textContent = 'Stopping recorder...';
  try {
    const r = await fetch('/api/apps/recording/stop', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        recordingId: rec.recordingId
      })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'stop failed');
    const draft = data.draft || {};
    const steps = Array.isArray(draft.steps) ? draft.steps : [];
    const nameEl = document.getElementById('appsAutomationsName');
    const descEl = document.getElementById('appsAutomationsDesc');
    if (nameEl && !nameEl.value && draft.name) nameEl.value = draft.name;
    if (descEl && !descEl.value && draft.description) descEl.value = draft.description;
    if (draft.captureRect) {
      if (!_appsAutomations.current) _appsAutomations.current = {
        id: null,
        steps: []
      };
      _appsAutomations.current.captureRect = draft.captureRect;
    }
    if (typeof _appsUpdateCaptureRectHint === 'function') _appsUpdateCaptureRectHint();
    state._appsBuilderSteps = steps;
    const stepsEl = document.getElementById('appsAutomationsSteps');
    if (stepsEl) stepsEl.value = _appsStepsToText(steps);
    if (typeof _appsRenderBuilderRows === 'function') _appsRenderBuilderRows();
    const cr = draft.captureRect;
    const rectNote = cr ? ' Capture rect ' + cr.w + 'x' + cr.h + ' - coords will scale at run time.' : '';
    const warnings = data.meta && Array.isArray(data.meta.errors || []) && data.meta.errors ? data.meta.errors : [];
    if (statusEl) statusEl.textContent = 'Captured ' + steps.length + ' step' + (steps.length === 1 ? '' : 's') + '.' + rectNote + ' Review and Save.';
    if (warnings.length && typeof toast === 'function') {
      toast('Recorder warnings: ' + warnings.join(' | '), 'warning', {
        duration: 6000
      });
    } else if (typeof toast === 'function') {
      toast('Recording captured (' + steps.length + ' steps).', 'success');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Stop failed: ' + e.message;
    if (typeof toast === 'function') toast('Stop failed: ' + e.message, 'error');
  }
}

// Live picker session. The SSE stream from /api/apps/uia/pick pushes hover
// updates + the final "picked" event; Esc in the target window cancels.
state._appsUiaPicker = null;
async function appsAutomationsPickElement() {
  if (state._appsUiaPicker) {
    state._appsUiaPicker.close();
    state._appsUiaPicker = null;
  }
  const statusEl = document.getElementById('appsAutomationsStatus');
  const resolved = await _appsResolveHwndForRecording();
  if (!resolved.hwnd) {
    const msg = 'Pick needs a running window for "' + (_appsAutomationsApp() || 'this app') + '". Launch the app from the Automation tab, then try again.';
    if (statusEl) statusEl.textContent = msg;
    if (typeof toast === 'function') toast(msg, 'warning');
    return;
  }
  _appsState.hwnd = resolved.hwnd;
  await _appsMaximizeHwnd(resolved.hwnd);
  const pickBtn = document.getElementById('appsAutomationsPickBtn');
  if (pickBtn) {
    pickBtn.disabled = true;
    pickBtn.style.opacity = '0.6';
  }
  if (statusEl) statusEl.textContent = 'Picker active. Hover the element and Ctrl+Click it in "' + (_appsAutomationsApp() || 'the app') + '". Esc cancels.';
  const url = '/api/apps/uia/pick?hwnd=' + encodeURIComponent(resolved.hwnd);
  const es = new EventSource(url);
  state._appsUiaPicker = es;
  const finish = reset => {
    if (pickBtn) {
      pickBtn.disabled = false;
      pickBtn.style.opacity = '';
    }
    try {
      es.close();
    } catch (_) {}
    if (state._appsUiaPicker === es) state._appsUiaPicker = null;
    if (reset && statusEl) statusEl.textContent = reset;
  };
  es.onmessage = msg => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch (_) {
      return;
    }
    if (ev.type === 'ready') return;
    if (ev.type === 'hover') {
      if (statusEl) {
        const label = ev.name || ev.id || '(no name)';
        statusEl.textContent = 'Over: ' + label + ' [' + (ev.controlType || '?') + ']. Ctrl+Click to pick.';
      }
      return;
    }
    if (ev.type === 'picked') {
      _appsInsertUiaStep(ev.selector, ev.name, ev.controlType);
      finish('Picked "' + (ev.name || ev.selector.id || ev.selector.class || '?') + '" [' + (ev.controlType || '?') + ']. Step added.');
      if (typeof toast === 'function') toast('UI element captured', 'success', {
        duration: 2000
      });
      // Refresh the tree so other picks surface newly-visible elements
      // (menus that opened, dialogs that appeared during the pick).
      try {
        appsAutomationsRefreshTree();
      } catch (_) {}
      return;
    }
    if (ev.type === 'cancelled') {
      finish('Picker cancelled (' + (ev.reason || '') + ').');
      return;
    }
    if (ev.type === 'error') {
      finish('Picker failed: ' + (ev.message || 'unknown'));
      if (typeof toast === 'function') toast('Picker failed: ' + (ev.message || ''), 'error');
      return;
    }
  };
  es.onerror = () => {
    // EventSource fires onerror on normal close too (when we `res.end()` after
    // picked/cancelled). Only treat it as an actual drop if we haven't
    // already transitioned out of the active state via a terminal event.
    if (state._appsUiaPicker !== es) return;
    finish('Picker connection lost - common cause: the target window is not automatable (try a different app, or check that UIA permissions are not blocking PowerShell).');
  };
}
async function appsAutomationsRunNow() {
  const saved = await appsAutomationsSave();
  if (!saved) return; // Save already toasted the reason.
  const cur = _appsAutomations.current;
  if (!cur || !cur.id) {
    if (typeof toast === 'function') toast('Run now: saved recipe has no id (unexpected). Try saving again.', 'error');
    return;
  }
  const resolved = await _appsResolveHwndForRecording();
  if (!resolved.hwnd) {
    if (typeof toast === 'function') toast('Launch the app first, then Run now.', 'warning');
    return;
  }
  _appsState.hwnd = resolved.hwnd;
  await _appsMaximizeHwnd(resolved.hwnd);
  const app = _appsAutomationsApp();
  try {
    const r = await fetch('/api/apps/session/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        recipeId: cur.id,
        hwnd: resolved.hwnd,
        app,
        provider: _appsState.providerKey || undefined
      })
    });
    let data = null;
    try {
      data = await r.json();
    } catch (_) {}
    if (!r.ok || !data || !data.ok) throw new Error(data && data.error || 'HTTP ' + r.status);
    _appsState.sessionId = data.sessionId || null;
    _appsState.running = true;
    _appsState.provider = data.label || data.provider || null;
    _appsState.model = data.model || null;
    if (typeof _appsUpdateRunningChrome === 'function') _appsUpdateRunningChrome(true);
    if (typeof toast === 'function') toast('Running "' + cur.name + '" against ' + app + '...', 'info', {
      duration: 2500
    });
    switchTab('apps');
  } catch (e) {
    if (typeof toast === 'function') toast('Run failed: ' + e.message, 'error');
  }
}

// Runs one step against the target window without saving. Used by the
// "Test step" button on each visual row so the user can iterate on a single
// step (e.g. tweaking a UIA selector) without replaying the whole recipe.
async function appsAutomationsTestStep(index) {
  const step = state._appsBuilderSteps && state._appsBuilderSteps[index];
  if (!step) return;
  const resolved = await _appsResolveHwndForRecording();
  if (!resolved.hwnd) {
    if (typeof toast === 'function') toast('Launch the app first.', 'warning');
    return;
  }
  _appsState.hwnd = resolved.hwnd;
  try {
    const r = await fetch('/api/apps/recipes/run-step', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        hwnd: resolved.hwnd,
        step,
        provider: _appsState.providerKey || undefined,
        captureRect: _appsAutomations.current && _appsAutomations.current.captureRect || null
      })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'step failed');
    if (typeof toast === 'function') toast('Step ran OK' + (data.info ? ' - ' + data.info : ''), 'success', {
      duration: 2500
    });
  } catch (e) {
    if (typeof toast === 'function') toast('Step failed: ' + e.message, 'error');
  }
}
async function appsAutomationsRefreshTree() {
  const treeEl = document.getElementById('appsAutomationsTree');
  if (!treeEl) return;
  const resolved = await _appsResolveHwndForRecording();
  if (!resolved.hwnd) {
    treeEl.innerHTML = '<div style="padding:8px;color:var(--subtext0);">Launch the app first.</div>';
    return;
  }
  _appsState.hwnd = resolved.hwnd;
  treeEl.innerHTML = '<div style="padding:8px;color:var(--subtext0);">Loading UIA tree...</div>';
  try {
    const r = await fetch('/api/apps/uia/tree', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        hwnd: resolved.hwnd
      })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'tree failed');
    const nodes = data.nodes || [];
    if (!nodes.length) {
      treeEl.innerHTML = '<div style="padding:8px;color:var(--subtext0);">No UIA-visible elements.</div>';
      return;
    }
    const esc = s => _appsEscape(String(s == null ? '' : s));
    const toStr = v => String(v == null ? '' : v);
    const rowStyle = 'color:#e0e0e0;background:#1e1e22;border:1px solid #2a2a30;border-radius:4px;padding:10px 12px;cursor:pointer;';
    const rowStyleAlt = 'color:#e0e0e0;background:#232328;border:1px solid #2a2a30;border-radius:4px;padding:10px 12px;cursor:pointer;';
    const rows = nodes.map((n, i) => {
      const name = toStr(n.name).trim();
      const aid = toStr(n.automationId).trim();
      const cls = toStr(n.class).trim();
      const tpe = toStr(n.type).trim();
      const primary = name || aid || cls || tpe || 'node ' + i;
      const rect = n.rect || {};
      const details = [];
      if (aid) details.push('<div style="margin-top:2px;"><span style="color:#8a8a95;">AutomationId:</span> <span style="color:#e0e0e0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">' + esc(aid) + '</span></div>');
      if (cls) details.push('<div style="margin-top:2px;"><span style="color:#8a8a95;">Class:</span> <span style="color:#e0e0e0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">' + esc(cls) + '</span></div>');
      if (tpe) details.push('<div style="margin-top:2px;"><span style="color:#8a8a95;">Control:</span> <span style="color:#e0e0e0;">' + esc(tpe) + '</span></div>');
      if (rect.w && rect.h) details.push('<div style="margin-top:2px;"><span style="color:#8a8a95;">Rect:</span> <span style="color:#e0e0e0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">' + rect.x + ',' + rect.y + ' ' + rect.w + 'x' + rect.h + '</span></div>');
      const detailsHtml = '<div class="apps-uia-details" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid #2a2a30;font-size:11px;color:#c8c8d0;">' + details.join('') + '<button type="button" onclick="event.stopPropagation();_appsUiaInsertRow(' + i + ')" style="margin-top:8px;background:#7c7cff;color:#000;border:none;border-radius:4px;padding:6px 12px;font-weight:600;font-size:11px;cursor:pointer;">Insert as step</button>' + '</div>';
      return '<div class="apps-uia-row" data-i="' + i + '" onclick="_appsUiaToggleRow(this)" title="Click to expand; use Insert as step to add" style="' + (i % 2 === 0 ? rowStyle : rowStyleAlt) + '">' + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">' + '<div style="flex:1;min-width:0;color:#ffffff;font-weight:500;font-size:13px;line-height:1.3;word-break:break-word;overflow-wrap:anywhere;">' + esc(primary) + '</div>' + '<div style="flex-shrink:0;color:#8a8a95;font-weight:400;font-size:11px;padding-top:2px;white-space:nowrap;">' + esc(tpe || 'element') + '</div>' + '</div>' + detailsHtml + '</div>';
    }).join('');
    treeEl.innerHTML = (data.truncated ? '<div style="padding:4px 6px;color:var(--overlay1);font:10px var(--font-mono);">truncated at ' + nodes.length + ' nodes</div>' : '') + rows;
    // Cache the raw nodes on the container so the row-level handlers can
    // pull selector data without re-rendering everything.
    treeEl._uiaNodes = nodes;
  } catch (e) {
    treeEl.innerHTML = '<div style="padding:8px;color:var(--red,#e06c75);">Tree failed: ' + _appsEscape(e.message) + '</div>';
  }
}
function _appsUiaToggleRow(rowEl) {
  if (!rowEl) return;
  const details = rowEl.querySelector('.apps-uia-details');
  if (!details) return;
  const open = details.style.display !== 'none' && details.style.display !== '';
  details.style.display = open ? 'none' : 'block';
}
function _appsUiaInsertRow(i) {
  const treeEl = document.getElementById('appsAutomationsTree');
  const nodes = treeEl && treeEl._uiaNodes;
  const n = nodes && nodes[i];
  if (!n) return;
  const selector = {};
  if (n.automationId) {
    selector.id = n.automationId;
    if (n.type) selector.type = n.type;
  } else {
    if (n.name) selector.name = n.name;
    if (n.type) selector.type = n.type;
    if (n.class && !n.name) selector.class = n.class;
  }
  _appsInsertUiaStep(selector, n.name, n.type);
  if (typeof toast === 'function') toast('Step inserted from tree.', 'success', {
    duration: 1600
  });
}
function _appsInsertUiaStep(selector, name, controlType) {
  if (!selector) return;
  const pretty = JSON.stringify({
    uia: selector
  });
  const labelBits = [];
  if (name) labelBits.push(name);
  if (controlType) labelBits.push('(' + controlType + ')');
  const notes = labelBits.length ? labelBits.join(' ') : undefined;
  const step = {
    verb: 'CLICK',
    target: pretty,
    text: '',
    notes
  };
  if (!Array.isArray(state._appsBuilderSteps)) state._appsBuilderSteps = [];
  state._appsBuilderSteps.push(step);
  const stepsEl = document.getElementById('appsAutomationsSteps');
  if (stepsEl) stepsEl.value = _appsStepsToText(state._appsBuilderSteps);
  if (typeof _appsRenderBuilderRows === 'function') _appsRenderBuilderRows();
}
const _APPS_PALETTE = [{
  label: 'Click element',
  step: {
    verb: 'CLICK',
    target: ''
  }
}, {
  label: 'Right-click element',
  step: {
    verb: 'RIGHT_CLICK',
    target: ''
  }
}, {
  label: 'Type text',
  step: {
    verb: 'TYPE',
    target: '',
    text: ''
  }
}, {
  label: 'Press key',
  step: {
    verb: 'PRESS',
    target: 'Enter'
  }
}, {
  label: 'Wait 500ms',
  step: {
    verb: 'WAIT',
    target: '500'
  }
}, {
  label: 'Wait until visible',
  step: {
    verb: 'WAIT_UNTIL',
    target: '',
    text: '10000'
  }
}, {
  label: 'Verify visible',
  step: {
    verb: 'VERIFY',
    target: ''
  }
}, {
  label: 'Scroll down',
  step: {
    verb: 'SCROLL',
    target: '0,5'
  }
}, {
  label: 'If ... / else / endif',
  multi: [{
    verb: 'IF',
    target: ''
  }, {
    verb: 'ELSE'
  }, {
    verb: 'ENDIF'
  }]
}, {
  label: 'Repeat N times',
  multi: [{
    verb: 'REPEAT',
    target: '3'
  }, {
    verb: 'ENDREPEAT'
  }]
}];
function _appsRenderStepPalette() {
  const wrap = document.getElementById('appsStepPalette');
  if (!wrap) return;
  wrap.innerHTML = _APPS_PALETTE.map((item, i) => `<div draggable="true" ondragstart="_appsPaletteDragStart(event, ${i})" onclick="_appsPaletteAppend(${i})" title="Click or drag into the step list" style="cursor:grab;padding:5px 7px;border-radius:4px;background:var(--surface0);border:1px solid var(--surface2);font:11px var(--font-ui);color:var(--text);">${_appsEscape(item.label)}</div>`).join('');
}
function _appsPaletteDragStart(ev, i) {
  state._appsBuilderDragIdx = null;
  try {
    ev.dataTransfer.setData('application/x-apps-palette', String(i));
    ev.dataTransfer.effectAllowed = 'copy';
  } catch (_) {}
}
function _appsPaletteAppend(i) {
  const item = _APPS_PALETTE[i];
  if (!item) return;
  if (item.multi) state._appsBuilderSteps.push(...item.multi.map(s => ({
    ...s
  })));else state._appsBuilderSteps.push({
    ...item.step
  });
  if (typeof _appsRenderBuilderRows === 'function') _appsRenderBuilderRows();
  if (typeof _appsSyncBuilderToText === 'function') _appsSyncBuilderToText();
}
function _appsAutomationsApp() {
  return _appsInstructionsKey();
}

// Convert the Instructions + Automations modals into first-class closable
// tab panels so users can keep them open, switch to other tabs, and come
// back. Runs once on first open; the inner .modal content is relocated
// into a new .tab-panel under .center.
function _appsPromoteModalToTab(modalId, panelId) {
  const existing = document.getElementById(panelId);
  if (existing) return existing;
  const overlay = document.getElementById(modalId);
  if (!overlay) return null;
  const inner = overlay.querySelector('.modal');
  if (!inner) return null;
  const center = document.querySelector('.center');
  if (!center) return null;
  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.id = panelId;
  panel.style.cssText = 'flex-direction:column; padding:14px 18px 18px; overflow:hidden; min-height:0;';
  // Flatten the modal inner to fill the tab panel.
  inner.style.maxWidth = 'none';
  inner.style.width = '100%';
  inner.style.maxHeight = 'none';
  inner.style.height = '100%';
  inner.style.boxShadow = 'none';
  inner.style.border = 'none';
  inner.style.background = 'transparent';
  inner.style.padding = '0';
  inner.style.display = 'flex';
  inner.style.flexDirection = 'column';
  inner.style.minHeight = '0';
  panel.appendChild(inner);
  overlay.remove();
  center.appendChild(panel);
  return panel;
}
async function appsOpenAutomations() {
  const app = _appsAutomationsApp();
  if (!app) {
    if (typeof toast === 'function') toast('Pick an app first.', 'warning');
    return;
  }
  _appsPromoteModalToTab('appsAutomationsModal', 'panel-automations-editor');
  const btn = document.getElementById('appsAutomationsTabBtn');
  const lbl = document.getElementById('appsAutomationsTabLabel');
  if (lbl) lbl.textContent = 'Automations - ' + app;
  if (btn) {
    // New tabs open at the far right of the bar, like the other closable
    // tabs (Work Item, Activity Timeline). Uses CSS `order` max+1 because
    // tabs are flex-ordered, not DOM-ordered.
    _placeTabAtEnd(btn);
    btn.style.display = '';
  }
  const nameEl = document.getElementById('appsAutomationsAppName');
  if (nameEl) nameEl.textContent = app;
  switchTab('automations-editor');
  _appsRenderStepPalette();
  const panel = document.getElementById('panel-automations-editor');
  if (panel && typeof lucide !== 'undefined') lucide.createIcons({
    el: panel
  });
  // Editor-scoped Ctrl+Z for the step list. Skips when a text input is
  // focused so native undo still works inside textareas.
  if (panel && !panel._undoWired) {
    panel._undoWired = true;
    panel.addEventListener('keydown', ev => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key !== 'z') return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
      ev.preventDefault();
      appsAutomationsUndo();
    });
  }
  await _appsAutomationsReload();
  // Auto-populate the UI elements tree so the user sees real options the
  // moment the editor opens, instead of a blank panel. Runs async (fire and
  // forget) so the rest of the editor stays responsive while the PS dump
  // resolves. Silent if the target app isn't picked yet.
  if (_appsState.hwnd || _appsAutomationsApp()) {
    try {
      appsAutomationsRefreshTree();
    } catch (_) {}
  }
  // Populate the "which AI" label + model picker in the generate block.
  const providerLbl = document.getElementById('appsAutomationsGenProvider');
  const modelSel = document.getElementById('appsAutomationsGenModel');
  const anth = (_appsState.providers || []).find(p => p.key === 'anthropic');
  if (providerLbl) {
    providerLbl.textContent = anth ? 'using Anthropic' : 'no Anthropic key - generate will fail';
    providerLbl.style.color = anth ? 'var(--subtext0)' : 'var(--red, #e06c75)';
  }
  if (modelSel) {
    // Generate now supports any provider the user has a key for. Each provider
    // group offers a small curated model list covering fast/balanced/strong.
    // Anthropic additionally benefits from the web_search tool server-side; the
    // other providers run without grounding.
    const available = (_appsState.providers || []).map(p => p.key);
    const groups = [{
      key: 'anthropic',
      label: 'Anthropic',
      models: [{
        id: 'claude-haiku-4-5-20251001',
        label: 'Haiku 4.5 (fast)'
      }, {
        id: 'claude-sonnet-4-6',
        label: 'Sonnet 4.6 (balanced)'
      }, {
        id: 'claude-opus-4-7',
        label: 'Opus 4.7 (strongest)'
      }]
    }, {
      key: 'openai',
      label: 'OpenAI',
      models: [{
        id: 'gpt-4o-mini',
        label: 'GPT-4o mini (fast)'
      }, {
        id: 'gpt-4o',
        label: 'GPT-4o (balanced)'
      }, {
        id: 'gpt-4.1',
        label: 'GPT-4.1 (strongest)'
      }]
    }, {
      key: 'gemini',
      label: 'Gemini',
      models: [{
        id: 'gemini-2.0-flash',
        label: 'Gemini 2.0 Flash (fast)'
      }, {
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash (balanced)'
      }, {
        id: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro (strongest)'
      }]
    }, {
      key: 'grok',
      label: 'Grok',
      models: [{
        id: 'grok-2-latest',
        label: 'Grok 2'
      }]
    }, {
      key: 'qwen',
      label: 'Qwen',
      models: [{
        id: 'qwen-plus',
        label: 'Qwen Plus'
      }, {
        id: 'qwen-max',
        label: 'Qwen Max'
      }]
    }].filter(g => available.includes(g.key));
    const saved = function () {
      try {
        return localStorage.getItem('sy.apps.genModel');
      } catch (_) {
        return null;
      }
    }();
    const savedProv = function () {
      try {
        return localStorage.getItem('sy.apps.genProvider');
      } catch (_) {
        return null;
      }
    }();
    if (groups.length === 0) {
      modelSel.innerHTML = '<option value="">(no API keys)</option>';
      modelSel.disabled = true;
    } else {
      modelSel.innerHTML = groups.map(g => '<optgroup label="' + g.label + '">' + g.models.map(m => '<option value="' + m.id + '" data-provider="' + g.key + '">' + m.label + '</option>').join('') + '</optgroup>').join('');
      // Pre-select by (savedProvider, savedModel) - falls back to the first
      // available group's first model, which is usually Haiku / GPT-4o mini.
      let chosen = null;
      if (saved) {
        for (const g of groups) for (const m of g.models) if (m.id === saved) chosen = m.id;
      }
      if (chosen) modelSel.value = chosen;
      modelSel.disabled = false;
    }
    modelSel.onchange = () => {
      try {
        localStorage.setItem('sy.apps.genModel', modelSel.value);
        const opt = modelSel.selectedOptions && modelSel.selectedOptions[0];
        if (opt && opt.dataset.provider) localStorage.setItem('sy.apps.genProvider', opt.dataset.provider);
      } catch (_) {}
    };
    if (providerLbl) {
      if (groups.length === 0) providerLbl.textContent = 'no API keys - add one in Settings';else if (groups.length === 1) providerLbl.textContent = 'using ' + groups[0].label;else providerLbl.textContent = '';
    }
  }
}
function appsCloseAutomations() {
  const btn = document.getElementById('appsAutomationsTabBtn');
  if (btn) btn.style.display = 'none';
  // Return to the Automation -> Apps tab the editor came from.
  switchTab('apps');
}
async function _appsAutomationsReload() {
  const app = _appsAutomationsApp();
  if (!app) return;
  try {
    const r = await fetch('/api/apps/recipes?app=' + encodeURIComponent(app));
    const data = await r.json();
    _appsState.recipes = data.recipes || [];
    _appsRenderAutomationsList();
  } catch (e) {
    if (typeof toast === 'function') toast('Load failed: ' + e.message, 'error');
  }
}
function _appsRenderAutomationsList() {
  const list = document.getElementById('appsAutomationsList');
  if (!list) return;
  const recipes = _appsState.recipes || [];
  if (!recipes.length) {
    list.innerHTML = '<div style="color:var(--overlay1); font:11px var(--font-ui); padding:12px 6px; text-align:center;">No automations yet.<br>Click New to create one.</div>';
    return;
  }
  list.innerHTML = recipes.map(r => {
    const active = _appsAutomations.current && _appsAutomations.current.id === r.id;
    const selected = _appsState.selectedRecipeId === r.id;
    const stepCount = (r.steps || []).length;
    return `<div class="apps-automation-row" data-id="${_appsEscape(r.id)}" onclick="appsAutomationsSelect('${_appsEscape(r.id)}')" style="cursor:pointer;padding:7px 9px;border-radius:5px;border:1px solid ${active ? 'var(--accent)' : 'transparent'};background:${active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent'};display:flex;flex-direction:column;gap:2px;">
      <div style="display:flex;align-items:center;gap:6px;font:500 12px var(--font-ui);color:var(--text);">
        ${selected ? '<i data-lucide="check-circle-2" style="width:12px;height:12px;color:var(--accent);"></i>' : ''}
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_appsEscape(r.name)}</span>
      </div>
      <div style="font:10px var(--font-ui);color:var(--subtext0);">${stepCount} step${stepCount === 1 ? '' : 's'}</div>
    </div>`;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons({
    el: list
  });
}
function appsAutomationsSelect(id) {
  const recipe = (_appsState.recipes || []).find(r => r.id === id);
  if (!recipe) return;
  _appsAutomations.current = JSON.parse(JSON.stringify(recipe));
  _appsAutomations.dirty = false;
  _appsAutomationsShowForm(true);
  document.getElementById('appsAutomationsName').value = recipe.name || '';
  document.getElementById('appsAutomationsDesc').value = recipe.description || '';
  document.getElementById('appsAutomationsVars').value = _appsVarsToText(recipe.variables || {});
  document.getElementById('appsAutomationsInputs').value = _appsInputsToText(recipe.inputs || []);
  document.getElementById('appsAutomationsSteps').value = _appsStepsToText(recipe.steps || []);
  const vp = document.getElementById('appsAutomationsVerifyPresent');
  const va = document.getElementById('appsAutomationsVerifyAbsent');
  if (vp) vp.value = (recipe.verify && recipe.verify.elementsPresent || []).join('\n');
  if (va) va.value = (recipe.verify && recipe.verify.elementsAbsent || []).join('\n');
  document.getElementById('appsAutomationsDeleteBtn').style.display = '';
  state._appsBuilderSteps = JSON.parse(JSON.stringify(recipe.steps || []));
  const winMaxEl = document.getElementById('appsAutomationsWinMax');
  const winWEl = document.getElementById('appsAutomationsWinW');
  const winHEl = document.getElementById('appsAutomationsWinH');
  const win = recipe.window || {};
  if (winMaxEl) winMaxEl.checked = !!win.maximized;
  if (winWEl) winWEl.value = win.w && !win.maximized ? String(win.w) : '';
  if (winHEl) winHEl.value = win.h && !win.maximized ? String(win.h) : '';
  _appsUpdateCaptureRectHint();
  appsAutomationsSetView('visual');
  _appsRenderAutomationsList();
}
function _appsUpdateCaptureRectHint() {
  const hint = document.getElementById('appsAutomationsCaptureRectHint');
  if (!hint) return;
  const cr = _appsAutomations.current && _appsAutomations.current.captureRect;
  if (cr && cr.w && cr.h) {
    hint.textContent = 'captured at ' + cr.w + 'x' + cr.h + ' - coords auto-scale';
  } else {
    hint.textContent = 'no capture rect - coords run as-is';
  }
}
function appsAutomationsNew() {
  _appsAutomations.current = {
    id: null,
    name: '',
    description: '',
    variables: {},
    steps: []
  };
  _appsAutomations.dirty = false;
  _appsAutomationsShowForm(true);
  document.getElementById('appsAutomationsName').value = '';
  document.getElementById('appsAutomationsDesc').value = '';
  document.getElementById('appsAutomationsVars').value = '';
  document.getElementById('appsAutomationsInputs').value = '';
  document.getElementById('appsAutomationsSteps').value = '';
  const vpN = document.getElementById('appsAutomationsVerifyPresent');
  if (vpN) vpN.value = '';
  const vaN = document.getElementById('appsAutomationsVerifyAbsent');
  if (vaN) vaN.value = '';
  const genI = document.getElementById('appsAutomationsGenInput');
  if (genI) genI.value = '';
  document.getElementById('appsAutomationsDeleteBtn').style.display = 'none';
  state._appsBuilderSteps = [];
  const winMaxN = document.getElementById('appsAutomationsWinMax');
  if (winMaxN) winMaxN.checked = false;
  const winWN = document.getElementById('appsAutomationsWinW');
  if (winWN) winWN.value = '';
  const winHN = document.getElementById('appsAutomationsWinH');
  if (winHN) winHN.value = '';
  _appsUpdateCaptureRectHint();
  appsAutomationsSetView('visual');
  document.getElementById('appsAutomationsName').focus();
  _appsRenderAutomationsList();
}
function _appsAutomationsShowForm(show) {
  document.getElementById('appsAutomationsEmpty').style.display = show ? 'none' : '';
  document.getElementById('appsAutomationsForm').style.display = show ? 'flex' : 'none';
  document.getElementById('appsAutomationsHistory').style.display = 'none';
  const palette = document.getElementById('appsStepPaletteWrap');
  if (palette) palette.style.display = show ? '' : 'none';
}
function appsAutomationsToggleHistory() {
  const hist = document.getElementById('appsAutomationsHistory');
  const form = document.getElementById('appsAutomationsForm');
  const empty = document.getElementById('appsAutomationsEmpty');
  const showing = hist.style.display !== 'none';
  if (showing) {
    hist.style.display = 'none';
    if (_appsAutomations.current) form.style.display = 'flex';else empty.style.display = '';
    return;
  }
  form.style.display = 'none';
  empty.style.display = 'none';
  hist.style.display = 'flex';
  _appsAutomationsLoadHistory();
}
async function _appsAutomationsLoadHistory() {
  const app = _appsAutomationsApp();
  const listEl = document.getElementById('appsAutomationsHistoryList');
  if (!listEl || !app) return;
  listEl.textContent = 'Loading...';
  try {
    const r = await fetch('/api/apps/recipes/history?app=' + encodeURIComponent(app));
    const data = await r.json();
    const runs = data && data.runs || [];
    if (!runs.length) {
      listEl.textContent = 'No runs yet.';
      return;
    }
    listEl.innerHTML = runs.map(run => {
      const when = new Date(run.at).toLocaleString();
      const icon = run.outcome === 'ok' ? 'check-circle-2' : run.outcome === 'aborted' ? 'circle-slash' : 'alert-circle';
      const color = run.outcome === 'ok' ? 'var(--green, #98c379)' : run.outcome === 'aborted' ? 'var(--subtext0)' : 'var(--red, #e06c75)';
      const dur = run.durationMs ? run.durationMs < 1000 ? run.durationMs + 'ms' : (run.durationMs / 1000).toFixed(1) + 's' : '-';
      return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--surface1);">
        <i data-lucide="${icon}" style="width:13px;height:13px;color:${color};"></i>
        <div style="flex:1;min-width:0;">
          <div style="color:var(--text);font:500 12px var(--font-ui);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_appsEscape(run.recipeName || '(unnamed)')}</div>
          <div style="color:var(--overlay1);font:10px var(--font-mono);">${when} - ${run.iterations || 0} steps - ${dur}${run.error ? ' - ' + _appsEscape(String(run.error).slice(0, 80)) : ''}</div>
        </div>
      </div>`;
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons({
      el: listEl
    });
  } catch (e) {
    listEl.textContent = 'Load failed: ' + e.message;
  }
}
function appsAutomationsTriggerImport() {
  const f = document.getElementById('appsAutomationsImportFile');
  if (f) f.click();
}
async function appsAutomationsImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const app = _appsAutomationsApp();
  if (!app) return;
  const statusEl = document.getElementById('appsAutomationsStatus');
  try {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      throw new Error('File is not valid JSON');
    }
    const r = await fetch('/api/apps/recipes/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        app,
        payload
      })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'import failed');
    if (statusEl) statusEl.textContent = 'Imported ' + data.imported + ' recipe' + (data.imported === 1 ? '' : 's') + '.';
    await _appsAutomationsReload();
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Import failed: ' + e.message;
    if (typeof toast === 'function') toast('Import failed: ' + e.message, 'error');
  }
}
async function appsAutomationsExportAll() {
  const app = _appsAutomationsApp();
  if (!app) return;
  try {
    const r = await fetch('/api/apps/recipes/export?app=' + encodeURIComponent(app));
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'export failed');
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (app || 'app').replace(/[^a-z0-9_-]+/gi, '-') + '-automations.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 200);
  } catch (e) {
    if (typeof toast === 'function') toast('Export failed: ' + e.message, 'error');
  }
}// ───── Visual step builder ──────────────────────────────────────────────
// Authoritative verb list — keep in sync with ALLOWED_VERBS in
// dashboard/apps-recipes.js. Mouse verbs grouped first, then keyboard,
// timing, locator, control flow.
const _APPS_VERBS = ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'MIDDLE_CLICK', 'DRAG', 'SCROLL', 'TYPE', 'PRESS', 'WAIT', 'WAIT_UNTIL', 'FIND', 'VERIFY', 'EXTRACT', 'IF', 'ELSE', 'ENDIF', 'REPEAT', 'ENDREPEAT'];
// Verbs that take text in addition to a target (TYPE field). EXTRACT uses
// the text field for the variable name to bind, DRAG for the destination.
const _APPS_VERBS_WITH_TEXT = new Set(['TYPE', 'WAIT_UNTIL', 'DRAG', 'EXTRACT']);
const _APPS_VERBS_BARE = new Set(['ELSE', 'ENDIF', 'ENDREPEAT']);
state._appsBuilderView = 'visual';
state._appsBuilderSteps = [];
state._appsBuilderDragIdx = null;
function appsAutomationsSetView(view) {
  // Switching views keeps the data in sync: visual -> text serializes steps,
  // text -> visual parses the textarea. Hold users' hands on syntax errors
  // so they don't lose work on a typo.
  const stepsEl = document.getElementById('appsAutomationsSteps');
  const visEl = document.getElementById('appsAutomationsVisual');
  const addBtn = document.getElementById('appsAutomationsAddRowBtn');
  const visBtn = document.getElementById('appsAutomationsViewVisual');
  const txtBtn = document.getElementById('appsAutomationsViewText');
  if (!stepsEl || !visEl) return;
  if (view === 'text') {
    stepsEl.value = _appsStepsToText(state._appsBuilderSteps);
    stepsEl.style.display = '';
    visEl.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    if (visBtn) {
      visBtn.style.background = 'transparent';
      visBtn.style.color = 'var(--subtext1)';
    }
    if (txtBtn) {
      txtBtn.style.background = 'var(--surface1)';
      txtBtn.style.color = 'var(--text)';
    }
  } else {
    try {
      state._appsBuilderSteps = _appsTextToSteps(stepsEl.value || '');
    } catch (e) {
      const statusEl = document.getElementById('appsAutomationsStatus');
      if (statusEl) statusEl.textContent = 'Cannot switch to Visual - fix: ' + e.message;
      return;
    }
    stepsEl.style.display = 'none';
    visEl.style.display = 'flex';
    if (addBtn) addBtn.style.display = '';
    if (visBtn) {
      visBtn.style.background = 'var(--surface1)';
      visBtn.style.color = 'var(--text)';
    }
    if (txtBtn) {
      txtBtn.style.background = 'transparent';
      txtBtn.style.color = 'var(--subtext1)';
    }
    _appsRenderBuilderRows();
  }
  state._appsBuilderView = view;
}

// Undo stack of the last N step-list snapshots. Each mutation pushes a
// JSON-cloned snapshot before mutating so Ctrl+Z can walk backward. Capped
// so an edit marathon doesn't eat memory.
const _APPS_UNDO_MAX = 40;
let _appsBuilderUndoStack = [];
function _appsBuilderSnapshot() {
  try {
    _appsBuilderUndoStack.push(JSON.parse(JSON.stringify(state._appsBuilderSteps || [])));
    if (_appsBuilderUndoStack.length > _APPS_UNDO_MAX) _appsBuilderUndoStack.shift();
  } catch (_) {}
}
function appsAutomationsUndo() {
  if (!_appsBuilderUndoStack.length) {
    if (typeof toast === 'function') toast('Nothing to undo.', 'info', {
      duration: 1200
    });
    return;
  }
  state._appsBuilderSteps = _appsBuilderUndoStack.pop();
  _appsRenderBuilderRows();
  _appsSyncBuilderToText();
  if (typeof toast === 'function') toast('Undo.', 'info', {
    duration: 900
  });
}
function appsAutomationsAddRow() {
  _appsBuilderSnapshot();
  state._appsBuilderSteps.push({
    verb: 'CLICK',
    target: ''
  });
  _appsRenderBuilderRows();
  _appsSyncBuilderToText();
}
function _appsBuilderRemove(i) {
  _appsBuilderSnapshot();
  state._appsBuilderSteps.splice(i, 1);
  _appsRenderBuilderRows();
  _appsSyncBuilderToText();
}
function _appsBuilderUpdate(i, field, value) {
  if (!state._appsBuilderSteps[i]) return;
  _appsBuilderSnapshot();
  if (value === '' || value == null) delete state._appsBuilderSteps[i][field];else state._appsBuilderSteps[i][field] = value;
  _appsSyncBuilderToText();
}
function _appsBuilderVerbChanged(i, newVerb) {
  const step = state._appsBuilderSteps[i];
  if (!step) return;
  _appsBuilderSnapshot();
  step.verb = newVerb;
  if (!_APPS_VERBS_WITH_TEXT.has(newVerb)) delete step.text;
  if (_APPS_VERBS_BARE.has(newVerb)) delete step.target;
  _appsRenderBuilderRows();
  _appsSyncBuilderToText();
}

// Custom verb-picker popup. Replaces the native <select> because Chromium's
// popup ignores --bg/--text on Windows and renders unreadable on dark UIs.
state._appsVerbPickEl = null;
function _appsVerbPickClose() {
  if (state._appsVerbPickEl && state._appsVerbPickEl.parentNode) state._appsVerbPickEl.parentNode.removeChild(state._appsVerbPickEl);
  state._appsVerbPickEl = null;
  document.removeEventListener('mousedown', _appsVerbPickOutside, true);
}
function _appsVerbPickOutside(e) {
  if (!state._appsVerbPickEl) return;
  if (state._appsVerbPickEl.contains(e.target)) return;
  if (e.target && e.target.classList && e.target.classList.contains('apps-verb-pick')) return;
  _appsVerbPickClose();
}
function _appsVerbPickToggle(event, i) {
  event.stopPropagation();
  if (state._appsVerbPickEl) {
    _appsVerbPickClose();
    return;
  }
  const btn = event.currentTarget;
  const rect = btn.getBoundingClientRect();
  const current = btn.getAttribute('data-verb') || '';
  const groups = [['Mouse', ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'MIDDLE_CLICK', 'DRAG', 'SCROLL']], ['Keyboard', ['TYPE', 'PRESS']], ['Timing', ['WAIT', 'WAIT_UNTIL']], ['Locate', ['FIND', 'VERIFY', 'EXTRACT']], ['Control', ['IF', 'ELSE', 'ENDIF', 'REPEAT', 'ENDREPEAT']]];
  const pop = document.createElement('div');
  pop.style.cssText = ['position:fixed', `top:${rect.bottom + 4}px`, `left:${rect.left}px`, 'min-width:170px', 'max-height:340px', 'overflow:auto', 'background:var(--surface0)', 'color:var(--text)', 'border:1px solid var(--surface2)', 'border-radius:6px', 'box-shadow:0 6px 24px rgba(0,0,0,0.45)', 'padding:4px', 'z-index:9999', 'font:11px var(--font-ui)'].join(';');
  for (const [label, verbs] of groups) {
    const head = document.createElement('div');
    head.textContent = label;
    head.style.cssText = 'padding:5px 9px 3px 9px;color:var(--overlay1);font-size:9.5px;text-transform:uppercase;letter-spacing:0.06em;';
    pop.appendChild(head);
    for (const v of verbs) {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = v;
      const isActive = v === current;
      item.style.cssText = ['display:block', 'width:100%', 'text-align:left', 'background:' + (isActive ? 'var(--blue)' : 'transparent'), 'color:' + (isActive ? 'var(--bg)' : 'var(--text)'), 'border:none', 'border-radius:4px', 'padding:5px 10px', 'font:11px var(--font-mono)', 'cursor:pointer'].join(';');
      item.onmouseenter = () => {
        if (!isActive) item.style.background = 'var(--surface1)';
      };
      item.onmouseleave = () => {
        if (!isActive) item.style.background = 'transparent';
      };
      item.onclick = e => {
        e.stopPropagation();
        _appsVerbPickClose();
        _appsBuilderVerbChanged(i, v);
      };
      pop.appendChild(item);
    }
  }
  document.body.appendChild(pop);
  state._appsVerbPickEl = pop;
  setTimeout(() => document.addEventListener('mousedown', _appsVerbPickOutside, true), 0);
}
function _appsSyncBuilderToText() {
  const stepsEl = document.getElementById('appsAutomationsSteps');
  if (stepsEl) stepsEl.value = _appsStepsToText(state._appsBuilderSteps);
}
function _appsRenderBuilderRows() {
  const container = document.getElementById('appsAutomationsVisual');
  if (!container) return;
  if (!state._appsBuilderSteps.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--overlay1);font:12px var(--font-ui);">No steps yet. Click <strong>Add step</strong> to start.</div>';
    return;
  }
  const rows = state._appsBuilderSteps.map((s, i) => {
    const verb = s.verb || 'CLICK';
    const showTarget = !_APPS_VERBS_BARE.has(verb);
    const showText = _APPS_VERBS_WITH_TEXT.has(verb);
    const indent = verb === 'ELSE' || verb === 'ENDIF' || verb === 'ENDREPEAT' ? '' : '';
    return `<div class="apps-builder-row" draggable="true" data-idx="${i}" ondragstart="_appsBuilderDragStart(event,${i})" ondragover="_appsBuilderDragOver(event,${i})" ondragleave="_appsBuilderDragLeave(event)" ondrop="_appsBuilderDrop(event,${i})" ondragend="_appsBuilderDragEnd(event)" style="display:flex;align-items:center;gap:6px;padding:5px 6px;background:var(--surface0);border:1px solid var(--surface1);border-radius:5px;">
      <span style="cursor:grab;color:var(--overlay1);padding:0 3px;" title="Drag to reorder">::</span>
      <span style="color:var(--overlay1);font:10px var(--font-mono);min-width:22px;text-align:right;">${i + 1}</span>
      <button type="button" class="apps-verb-pick" data-idx="${i}" data-verb="${verb}" onclick="_appsVerbPickToggle(event,${i})" style="background:var(--bg);color:var(--text);border:1px solid var(--surface2);border-radius:4px;padding:4px 22px 4px 8px;font:11px var(--font-ui);min-width:118px;text-align:left;cursor:pointer;position:relative;">${verb}<span style="position:absolute;right:7px;top:50%;transform:translateY(-50%);color:var(--overlay1);font-size:9px;">&#9660;</span></button>
      ${showTarget ? _appsBuilderTargetControl(i, s, verb) : '<span style="flex:1;color:var(--overlay1);font:11px var(--font-ui);font-style:italic;">(block marker)</span>'}
      ${showText ? `<span style="color:var(--overlay1);">→</span><input type="text" placeholder="text to type" value="${_appsEscape(s.text || '')}" oninput="_appsBuilderUpdate(${i},'text',this.value)" style="flex:1;min-width:100px;background:var(--bg);color:var(--text);border:1px solid var(--surface2);border-radius:4px;padding:4px 8px;font:12px var(--font-mono);outline:none;">` : ''}
      <button type="button" onclick="appsAutomationsTestStep(${i})" title="Test just this step against the target window" style="background:transparent;border:1px solid var(--surface2);color:var(--subtext1);cursor:pointer;padding:2px 7px;font:10px var(--font-ui);border-radius:3px;">Test</button>
      <button type="button" onclick="_appsBuilderRemove(${i})" title="Delete step" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:2px 6px;font-size:14px;line-height:1;">×</button>
    </div>`;
  }).join('');
  container.innerHTML = rows;
}

// Render the right control for a step's target. UIA-shaped targets get a
// chip with a re-pick button so the user doesn't have to read raw JSON.
function _appsBuilderTargetControl(i, step, verb) {
  const placeholder = _appsTargetPlaceholder(verb);
  const target = step.target || '';
  let parsed = null;
  if (target && target.trim().startsWith('{')) {
    try {
      parsed = JSON.parse(target);
    } catch (_) {}
  }
  if (parsed && parsed.uia) {
    const sel = parsed.uia;
    const label = (step.notes || '').replace(/^UIA:\s*/, '').split('@')[0].trim() || sel.id || sel.name || sel.class || '(ui element)';
    const sub = sel.id ? '#' + sel.id : sel.type ? '[' + sel.type + ']' : '';
    return '<div style="flex:1;min-width:120px;display:flex;align-items:center;gap:6px;background:color-mix(in srgb, var(--accent) 10%, transparent);border:1px solid color-mix(in srgb, var(--accent) 35%, transparent);border-radius:4px;padding:3px 8px;min-height:24px;">' + '<i data-lucide="crosshair" style="width:11px;height:11px;color:var(--accent);"></i>' + '<span style="font:12px var(--font-ui);color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _appsEscape(label) + ' <span style="color:var(--overlay1);">' + _appsEscape(sub) + '</span></span>' + '<button type="button" onclick="appsAutomationsRepickStep(' + i + ')" title="Re-pick this element" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:2px 6px;font:10px var(--font-ui);">re-pick</button>' + '<button type="button" onclick="_appsBuilderClearUia(' + i + ')" title="Convert to plain coords / description" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:2px 6px;font:10px var(--font-ui);">edit as text</button>' + '</div>';
  }
  return `<input type="text" placeholder="${placeholder}" value="${_appsEscape(target)}" oninput="_appsBuilderUpdate(${i},'target',this.value)" style="flex:1;min-width:120px;background:var(--bg);color:var(--text);border:1px solid var(--surface2);border-radius:4px;padding:4px 8px;font:12px var(--font-mono);outline:none;">`;
}
function _appsBuilderClearUia(i) {
  const step = state._appsBuilderSteps[i];
  if (!step) return;
  _appsBuilderSnapshot();
  // Drop the JSON and expose the stashed fallback coords (or empty) for edit.
  try {
    const parsed = JSON.parse(step.target);
    step.target = parsed && parsed.xy ? parsed.xy : '';
  } catch (_) {
    step.target = '';
  }
  _appsRenderBuilderRows();
  _appsSyncBuilderToText();
}

// Re-pick a UIA element for an existing step: kick the picker, replace the
// target on success, keep the other fields intact.
async function appsAutomationsRepickStep(i) {
  const step = state._appsBuilderSteps[i];
  if (!step) return;
  const resolved = await _appsResolveHwndForRecording();
  if (!resolved.hwnd) {
    if (typeof toast === 'function') toast('Launch the app first.', 'warning');
    return;
  }
  _appsState.hwnd = resolved.hwnd;
  await _appsMaximizeHwnd(resolved.hwnd);
  const url = '/api/apps/uia/pick?hwnd=' + encodeURIComponent(resolved.hwnd);
  const es = new EventSource(url);
  const statusEl = document.getElementById('appsAutomationsStatus');
  if (statusEl) statusEl.textContent = 'Re-pick step ' + (i + 1) + ': Ctrl+Click the new element, Esc cancels.';
  es.onmessage = msg => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch (_) {
      return;
    }
    if (ev.type === 'picked' && ev.selector) {
      _appsBuilderSnapshot();
      step.target = JSON.stringify({
        uia: ev.selector
      });
      step.notes = 'UIA: ' + (ev.name || ev.selector.id || '?') + (ev.controlType ? ' (' + ev.controlType + ')' : '');
      _appsRenderBuilderRows();
      _appsSyncBuilderToText();
      if (statusEl) statusEl.textContent = 'Step ' + (i + 1) + ' re-picked.';
      try {
        es.close();
      } catch (_) {}
    } else if (ev.type === 'cancelled' || ev.type === 'error') {
      try {
        es.close();
      } catch (_) {}
      if (statusEl) statusEl.textContent = 'Re-pick ' + ev.type + (ev.message ? ': ' + ev.message : '');
    }
  };
  es.onerror = () => {
    try {
      es.close();
    } catch (_) {}
  };
}
function _appsTargetPlaceholder(verb) {
  switch (verb) {
    case 'CLICK':
      return 'element description or x,y';
    case 'TYPE':
      return 'optional: element to focus first';
    case 'PRESS':
      return 'key combo (Enter, Ctrl+S, ...)';
    case 'WAIT':
      return 'milliseconds (e.g. 500)';
    case 'WAIT_UNTIL':
      return 'element to wait for';
    case 'FIND':
    case 'VERIFY':
      return 'element description';
    case 'SCROLL':
      return 'dx,dy ticks (e.g. 0,5)';
    case 'DRAG':
      return 'fromX,fromY (e.g. 100,200)';
    case 'IF':
      return 'condition: element exists?';
    case 'REPEAT':
      return 'number of times (e.g. 5)';
    default:
      return '';
  }
}
function _appsBuilderDragStart(ev, i) {
  state._appsBuilderDragIdx = i;
  try {
    ev.dataTransfer.setData('text/plain', String(i));
    ev.dataTransfer.effectAllowed = 'move';
  } catch (_) {}
  ev.currentTarget.style.opacity = '0.5';
}
function _appsBuilderDragOver(ev) {
  ev.preventDefault();
  ev.currentTarget.style.outline = '2px solid var(--accent)';
}
function _appsBuilderDragLeave(ev) {
  ev.currentTarget.style.outline = '';
}
function _appsBuilderDrop(ev, i) {
  ev.preventDefault();
  ev.currentTarget.style.outline = '';
  // Palette drop: insert new step(s) at position i.
  let paletteIdx = null;
  try {
    paletteIdx = ev.dataTransfer && ev.dataTransfer.getData('application/x-apps-palette');
  } catch (_) {}
  if (paletteIdx !== null && paletteIdx !== '') {
    const item = _APPS_PALETTE[parseInt(paletteIdx, 10)];
    if (item) {
      const inserts = item.multi ? item.multi.map(s => ({
        ...s
      })) : [{
        ...item.step
      }];
      state._appsBuilderSteps.splice(i, 0, ...inserts);
      _appsRenderBuilderRows();
      _appsSyncBuilderToText();
      return;
    }
  }
  // Existing-row drop: reorder.
  const from = state._appsBuilderDragIdx;
  if (from == null || from === i) return;
  const [moved] = state._appsBuilderSteps.splice(from, 1);
  state._appsBuilderSteps.splice(i, 0, moved);
  _appsRenderBuilderRows();
  _appsSyncBuilderToText();
}

// Accept palette drops into an empty visual area too.
function _appsPaletteAreaDrop(ev) {
  ev.preventDefault();
  let paletteIdx = null;
  try {
    paletteIdx = ev.dataTransfer && ev.dataTransfer.getData('application/x-apps-palette');
  } catch (_) {}
  if (paletteIdx === null || paletteIdx === '') return;
  const item = _APPS_PALETTE[parseInt(paletteIdx, 10)];
  if (!item) return;
  if (item.multi) state._appsBuilderSteps.push(...item.multi.map(s => ({
    ...s
  })));else state._appsBuilderSteps.push({
    ...item.step
  });
  _appsRenderBuilderRows();
  _appsSyncBuilderToText();
}
function _appsBuilderDragEnd() {
  state._appsBuilderDragIdx = null;
  document.querySelectorAll('.apps-builder-row').forEach(el => {
    el.style.opacity = '';
    el.style.outline = '';
  });
}
async function appsSaveCurrentAsAutomation() {
  if (!_appsState.sessionId) {
    if (typeof toast === 'function') toast('No active session.', 'warning');
    return;
  }
  const name = prompt('Name this automation:');
  if (!name || !name.trim()) return;
  try {
    const r = await fetch('/api/apps/recipes/from-session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: _appsState.sessionId,
        name: name.trim()
      })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    if (typeof toast === 'function') toast('Saved "' + name.trim() + '" (' + data.captured + ' steps).', 'success', {
      duration: 2500
    });
  } catch (e) {
    if (typeof toast === 'function') toast('Save failed: ' + e.message, 'error');
  }
}
function _appsStepsToText(steps) {
  return (steps || []).map(s => {
    let line = s.verb || '';
    if (s.target) line += ' ' + s.target;
    if (s.text) line += ' -> ' + s.text;
    if (s.notes) line += '   // ' + s.notes;
    return line;
  }).join('\n');
}
function _appsVarsToText(vars) {
  const entries = Object.entries(vars || {});
  return entries.map(([k, v]) => `${k} = ${v}`).join('\n');
}
function _appsInputsToText(inputs) {
  return (inputs || []).map(i => {
    const parts = [i.name];
    if (i.label && i.label !== i.name) parts.push(i.label);
    if (i.placeholder) parts.push(i.placeholder);
    return parts.join(' | ');
  }).join('\n');
}
function _appsTextToInputs(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map(s => s.trim());
    const name = parts[0];
    if (!name) throw new Error('input line missing name: ' + line);
    if (!/^[\w-]+$/.test(name)) throw new Error('input name "' + name + '" must be letters/digits/_ only');
    out.push({
      name,
      label: parts[1] || name,
      placeholder: parts[2] || undefined
    });
  }
  return out;
}

// Modal prompt collecting values for a recipe's inputs. Resolves with a
// { name: value } map, or null if the user cancelled.
function _appsCollectInputs(recipe) {
  const inputs = recipe && recipe.inputs || [];
  if (!inputs.length) return Promise.resolve({});
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
    const fields = inputs.map((f, i) => '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;">' + '<label style="font:600 11px var(--font-ui);color:var(--subtext0);">' + _appsEscape(f.label || f.name) + '</label>' + '<input type="text" data-idx="' + i + '" placeholder="' + _appsEscape(f.placeholder || '') + '" value="' + _appsEscape(f.default || '') + '" style="background:var(--surface0);color:var(--text);border:1px solid var(--surface2);border-radius:4px;padding:7px 10px;font:12px var(--font-ui);outline:none;">' + '</div>').join('');
    overlay.innerHTML = '<div style="background:var(--base);border:1px solid var(--surface1);border-radius:var(--radius-lg);padding:0;width:440px;max-width:92vw;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.6);">' + '<div style="padding:16px 20px 8px;font:600 13px var(--font-ui);color:var(--text);">Run "' + _appsEscape(recipe.name || '') + '"</div>' + '<div style="padding:4px 20px 10px;font:11px var(--font-ui);color:var(--subtext0);">Fill in the inputs, then Run.</div>' + '<div id="appsInputsFieldWrap" style="padding:4px 20px 8px;">' + fields + '</div>' + '<div style="padding:10px 20px 16px;display:flex;gap:8px;justify-content:flex-end;">' + '<button id="_appsInputsCancel" style="padding:7px 14px;background:var(--surface1);color:var(--text);border:none;border-radius:var(--radius);font:12px var(--font-ui);cursor:pointer;">Cancel</button>' + '<button id="_appsInputsRun" style="padding:7px 14px;background:var(--accent);color:var(--crust);border:none;border-radius:var(--radius);font:12px var(--font-ui);font-weight:600;cursor:pointer;">Run</button>' + '</div>' + '</div>';
    document.body.appendChild(overlay);
    const run = () => {
      const values = {};
      const els = overlay.querySelectorAll('input[data-idx]');
      els.forEach(el => {
        const i = parseInt(el.getAttribute('data-idx'), 10);
        const def = inputs[i];
        values[def.name] = (el.value || '').trim() || def.default || '';
      });
      overlay.remove();
      resolve(values);
    };
    overlay.querySelector('#_appsInputsRun').onclick = run;
    overlay.querySelector('#_appsInputsCancel').onclick = () => {
      overlay.remove();
      resolve(null);
    };
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(null);
      }
    });
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    const first = overlay.querySelector('input[data-idx]');
    if (first) first.focus();
  });
}
function _appsTextToVars(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error('Variable line missing "=": ' + line);
    const name = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (!name) throw new Error('Variable name is empty');
    if (!/^[\w-]+$/.test(name)) throw new Error('Variable name "' + name + '" must be letters/digits/_ only');
    if (!val) throw new Error('Variable "' + name + '" has no value');
    out[name] = val;
  }
  return out;
}
function _appsTextToSteps(text) {
  const out = [];
  // Mirror of _APPS_VERBS — kept as a Set so the parser is fast.
  const verbs = new Set(_APPS_VERBS);
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\w+)\s*(.*)$/);
    if (!m) continue;
    const verb = m[1].toUpperCase();
    if (!verbs.has(verb)) throw new Error('Unknown verb "' + m[1] + '". Allowed: ' + _APPS_VERBS.join(', ') + '.');
    let rest = m[2] || '';
    let notes;
    const noteIdx = rest.indexOf('//');
    if (noteIdx >= 0) {
      notes = rest.slice(noteIdx + 2).trim() || undefined;
      rest = rest.slice(0, noteIdx).trim();
    }
    let target, text;
    const arrow = rest.indexOf('->');
    if (arrow >= 0) {
      target = rest.slice(0, arrow).trim() || undefined;
      text = rest.slice(arrow + 2).trim() || undefined;
    } else {
      target = rest || undefined;
    }
    out.push({
      verb,
      target,
      text,
      notes
    });
  }
  return out;
}
async function appsAutomationsSave() {
  const app = _appsAutomationsApp();
  if (!app) {
    if (typeof toast === 'function') toast('No app selected for this automation.', 'warning');
    return false;
  }
  const nameEl = document.getElementById('appsAutomationsName');
  const descEl = document.getElementById('appsAutomationsDesc');
  const stepsEl = document.getElementById('appsAutomationsSteps');
  const statusEl = document.getElementById('appsAutomationsStatus');
  const varsEl = document.getElementById('appsAutomationsVars');
  const inputsEl = document.getElementById('appsAutomationsInputs');
  const name = (nameEl.value || '').trim();
  if (!name) {
    if (statusEl) statusEl.textContent = 'Name is required.';
    if (typeof toast === 'function') toast('Name is required before saving.', 'warning');
    try {
      nameEl.focus();
    } catch (_) {}
    return false;
  }
  let variables;
  try {
    variables = _appsTextToVars(varsEl.value);
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Variable error: ' + e.message;
    if (typeof toast === 'function') toast('Variable error: ' + e.message, 'error');
    return false;
  }
  let inputs;
  try {
    inputs = _appsTextToInputs(inputsEl.value);
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Input error: ' + e.message;
    if (typeof toast === 'function') toast('Input error: ' + e.message, 'error');
    return false;
  }
  // Source of truth for steps depends on which view is active. The visual
  // builder mutates _appsBuilderSteps directly (drag, delete, edit) and only
  // syncs to the textarea on view-switch - so when the user is in visual mode
  // we must read from _appsBuilderSteps or recorded/edited steps get dropped.
  let steps;
  if (state._appsBuilderView === 'visual' && Array.isArray(state._appsBuilderSteps) && state._appsBuilderSteps.length) {
    steps = state._appsBuilderSteps;
  } else {
    try {
      steps = _appsTextToSteps(stepsEl.value);
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Step error: ' + e.message;
      if (typeof toast === 'function') toast('Step error: ' + e.message, 'error');
      return false;
    }
  }
  if (!steps.length) {
    if (statusEl) statusEl.textContent = 'Add at least one step.';
    if (typeof toast === 'function') toast('Add at least one step before saving.', 'warning');
    return false;
  }
  const linesToArr = v => String(v || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const vPresent = linesToArr((document.getElementById('appsAutomationsVerifyPresent') || {}).value);
  const vAbsent = linesToArr((document.getElementById('appsAutomationsVerifyAbsent') || {}).value);
  const verify = vPresent.length || vAbsent.length ? {
    elementsPresent: vPresent,
    elementsAbsent: vAbsent
  } : undefined;
  const captureRect = _appsAutomations.current && _appsAutomations.current.captureRect || null;
  // Window-setup controls (optional: recipes without either are unchanged).
  const winMax = !!(document.getElementById('appsAutomationsWinMax') || {}).checked;
  const winW = parseInt((document.getElementById('appsAutomationsWinW') || {}).value || '', 10);
  const winH = parseInt((document.getElementById('appsAutomationsWinH') || {}).value || '', 10);
  let windowPin;
  if (winMax) windowPin = {
    maximized: true
  };else if (Number.isFinite(winW) && winW > 0 && Number.isFinite(winH) && winH > 0) windowPin = {
    w: winW,
    h: winH
  };
  const recipe = {
    id: _appsAutomations.current && _appsAutomations.current.id || undefined,
    name,
    description: (descEl.value || '').trim(),
    variables: Object.keys(variables).length ? variables : undefined,
    inputs: inputs.length ? inputs : undefined,
    verify,
    captureRect: captureRect || undefined,
    window: windowPin,
    steps
  };
  if (statusEl) statusEl.textContent = 'Saving...';
  try {
    const r = await fetch('/api/apps/recipes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        app,
        recipe
      })
    });
    // A non-2xx from permGate denial or validation returns {error:"..."} with
    // no `ok` flag - treat that as failure with a visible message, not a
    // silent "still saving..." hang.
    let data = null;
    try {
      data = await r.json();
    } catch (_) {}
    if (!r.ok || !data || !data.ok) {
      const msg = data && data.error || 'HTTP ' + r.status;
      if (statusEl) statusEl.textContent = 'Save failed: ' + msg;
      if (typeof toast === 'function') toast('Save failed: ' + msg, 'error');
      return false;
    }
    if (statusEl) statusEl.textContent = 'Saved.';
    if (typeof toast === 'function') toast('Saved "' + recipe.name + '"', 'success', {
      duration: 1800
    });
    _appsAutomations.current = data.recipe;
    await _appsAutomationsReload();
    _appsAutomationsShowForm(true);
    document.getElementById('appsAutomationsDeleteBtn').style.display = '';
    return true;
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Save failed: ' + e.message;
    if (typeof toast === 'function') toast('Save failed: ' + e.message, 'error');
    return false;
  }
}
async function appsAutomationsDelete() {
  const app = _appsAutomationsApp();
  const cur = _appsAutomations.current;
  if (!app || !cur || !cur.id) return;
  const ok = await confirmDialog('Delete automation "' + cur.name + '"?', {
    confirmText: 'Delete',
    cancelText: 'Cancel',
    danger: true
  });
  if (!ok) return;
  try {
    await fetch('/api/apps/recipes?app=' + encodeURIComponent(app) + '&id=' + encodeURIComponent(cur.id), {
      method: 'DELETE'
    });
    if (_appsState.selectedRecipeId === cur.id) {
      _appsState.selectedRecipeId = null;
      _appsState.selectedRecipeName = null;
      _appsSyncComposerMode();
    }
    _appsAutomations.current = null;
    _appsAutomationsShowForm(false);
    await _appsAutomationsReload();
  } catch (e) {
    if (typeof toast === 'function') toast('Delete failed: ' + e.message, 'error');
  }
}
async function appsAutomationsRunSelected() {
  const cur = _appsAutomations.current;
  if (!cur || !cur.id) {
    if (typeof toast === 'function') toast('Save the automation first, then select it.', 'warning');
    return;
  }
  _appsState.selectedRecipeId = cur.id;
  _appsState.selectedRecipeName = cur.name;
  _appsState.selectedRecipeInputDefs = Array.isArray(cur.inputs) ? cur.inputs : [];
  _appsSyncComposerMode();
  _appsRenderAutomationsList();
  appsCloseAutomations();
  if (typeof toast === 'function') toast('Next Start will run "' + cur.name + '".', 'info', {
    duration: 2500
  });
}
function appsClearSelectedRecipe() {
  _appsState.selectedRecipeId = null;
  _appsState.selectedRecipeName = null;
  _appsSyncComposerMode();
}
function appsOpenLauncher() {
  const panel = document.getElementById('appsLauncher');
  if (!panel) return;
  panel.hidden = false;
  appsRefreshAll();
  const search = document.getElementById('appsLauncherSearch');
  if (search) {
    search.value = '';
    search.focus();
  }
  appsRenderLauncher();
}
function appsCloseLauncher() {
  const panel = document.getElementById('appsLauncher');
  if (panel) panel.hidden = true;
}
function appsSetLauncherSection(sec) {
  _appsLauncher.section = sec;
  document.querySelectorAll('.apps-launcher-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.sec === sec);
  });
  appsRenderLauncher();
}
function _appsNameFromPath(p) {
  if (!p) return 'App';
  const base = String(p).split(/[\\/]/).pop() || '';
  return base.replace(/\.exe$/i, '') || 'App';
}
function _appsInitial(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  return s[0].toUpperCase();
}
function _appsResolveName(name, iconKey) {
  const n = String(name || '').trim();
  if (n) return n;
  const key = String(iconKey || '');
  if (key) {
    const base = key.split(/[\\/]/).pop();
    return base.replace(/\.exe$/i, '') || 'App';
  }
  return 'App';
}
function _appsBuildCard({
  key,
  name,
  sub,
  iconKey,
  canDelete,
  onClick
}) {
  const displayName = _appsResolveName(name, iconKey);
  const card = document.createElement('div');
  card.className = 'apps-launcher-card';
  card.dataset.key = key || '';
  card.dataset.iconKey = iconKey || '';
  card.addEventListener('click', onClick);
  if (canDelete) {
    const del = document.createElement('button');
    del.className = 'apps-launcher-del';
    del.title = 'Remove';
    del.innerHTML = '&times;';
    del.addEventListener('click', e => {
      e.stopPropagation();
      appsRemoveManual(key);
    });
    card.appendChild(del);
  }
  const icon = document.createElement('div');
  icon.className = 'apps-launcher-icon';
  const cached = _appsLauncher.iconCache[iconKey];
  if (cached) {
    const img = document.createElement('img');
    img.src = cached;
    img.alt = '';
    icon.appendChild(img);
  } else {
    icon.textContent = _appsInitial(displayName);
  }
  card.appendChild(icon);
  const nameEl = document.createElement('div');
  nameEl.className = 'apps-launcher-name';
  nameEl.title = displayName;
  nameEl.textContent = displayName;
  card.appendChild(nameEl);
  if (sub) {
    const subEl = document.createElement('div');
    subEl.className = 'apps-launcher-sub';
    subEl.textContent = sub;
    card.appendChild(subEl);
  }
  return card;
}
function appsRenderLauncher() {
  const grid = document.getElementById('appsLauncherGrid');
  if (!grid) return;
  const q = (document.getElementById('appsLauncherSearch')?.value || '').trim().toLowerCase();
  const sec = _appsLauncher.section;
  let items = [];
  if (sec === 'running') {
    items = (_appsState.windows || []).filter(w => w.title && !w.isMinimized).map(w => ({
      key: 'win:' + w.hwnd,
      name: w.title,
      sub: w.processName,
      onClick: () => {
        _appsSetSelected({
          hwnd: w.hwnd,
          title: w.title,
          app: w.processName
        });
        appsCloseLauncher();
      },
      iconKey: null
    }));
  } else if (sec === 'installed') {
    items = (_appsLauncher.installed || []).map(a => ({
      key: 'ins:' + (a.id || a.path),
      name: a.name || _appsNameFromPath(a.path),
      iconKey: a.path || a.id,
      onClick: () => appsLaunchAndSelect(a)
    }));
  } else if (sec === 'manual') {
    items = _appsLoadManual().map(a => ({
      key: 'man:' + a.path,
      name: a.name || _appsNameFromPath(a.path),
      iconKey: a.path,
      canDelete: true,
      onClick: () => appsLaunchAndSelect({
        name: a.name,
        path: a.path
      })
    }));
  }
  if (q) {
    items = items.filter(i => (i.name + ' ' + (i.sub || '')).toLowerCase().includes(q));
  }
  grid.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'apps-launcher-empty';
    empty.textContent = sec === 'running' ? 'No running windows. Launch or switch to the app you want to drive.' : sec === 'installed' ? 'No installed apps found. Try Refresh.' : 'No manual apps. Use "+ Add app" to add one by path.';
    grid.appendChild(empty);
    return;
  }
  for (const i of items) grid.appendChild(_appsBuildCard(i));

  // Lazy-load icons for visible cards.
  items.forEach(i => {
    if (i.iconKey && !_appsLauncher.iconCache[i.iconKey]) _appsLazyIcon(i.iconKey);
  });
}
async function _appsLazyIcon(iconKey) {
  if (_appsLauncher.iconCache[iconKey]) return;
  if (_appsLauncher.iconPending[iconKey]) return _appsLauncher.iconPending[iconKey];
  const p = (async () => {
    try {
      const r = await fetch('/api/apps/icon?id=' + encodeURIComponent(iconKey));
      const data = await r.json();
      if (data.ok && data.base64) {
        const url = 'data:' + (data.mimeType || 'image/png') + ';base64,' + data.base64;
        _appsLauncher.iconCache[iconKey] = url;
        document.querySelectorAll('.apps-launcher-card').forEach(card => {
          if (card.dataset.iconKey !== iconKey) return;
          const icon = card.querySelector('.apps-launcher-icon');
          if (!icon) return;
          icon.textContent = '';
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          icon.appendChild(img);
        });
      } else {
        _appsLauncher.iconCache[iconKey] = null;
      }
    } catch (_) {
      _appsLauncher.iconCache[iconKey] = null;
    }
    delete _appsLauncher.iconPending[iconKey];
  })();
  _appsLauncher.iconPending[iconKey] = p;
  return p;
}
async function appsLaunchAndSelect(app) {
  // If the app is already running (a visible window matches its name or
  // its exe basename), just select that window - no launch needed.
  await appsRefreshWindows();
  const hay = [app.name, app.path && app.path.split(/[\\/]/).pop()].filter(Boolean).map(s => s.toLowerCase());
  const match = (_appsState.windows || []).find(w => {
    if (!w.title || w.isMinimized) return false;
    const blob = ((w.title || '') + ' ' + (w.processName || '')).toLowerCase();
    return hay.some(h => blob.includes(h) || h.includes((w.processName || '').toLowerCase()));
  });
  if (match) {
    _appsState.pendingLaunchSpec = null;
    _appsSetSelected({
      hwnd: match.hwnd,
      title: match.title,
      app: match.processName
    });
    appsCloseLauncher();
    return;
  }

  // Deferred launch: remember what the user picked but DO NOT open the app
  // yet. Start / Run automation will do the open + focus + session atomically,
  // so the user isn't left with a half-opened app when they're still writing
  // their prompt.
  _appsState.pendingLaunchSpec = {
    id: app.id || null,
    path: app.path || null,
    name: app.name || null
  };
  _appsSetSelected({
    app: app.name,
    title: '(will launch on Start)'
  });
  appsCloseLauncher();
}
async function _appsLaunchIfPending() {
  const spec = _appsState.pendingLaunchSpec;
  if (!spec) return true;
  try {
    const r = await fetch('/api/apps/launch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(spec)
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'launch failed');
    _appsState.pendingLaunchSpec = null;
    _appsSetSelected({
      hwnd: data.hwnd,
      title: data.title,
      app: data.processName || spec.name
    });
    await appsRefreshWindows();
    return true;
  } catch (e) {
    if (typeof toast === 'function') toast('Launch failed: ' + e.message, 'error');
    return false;
  }
}
function appsToggleAddForm(forceShow) {
  const form = document.getElementById('appsLauncherAddForm');
  if (!form) return;
  const show = typeof forceShow === 'boolean' ? forceShow : form.hidden;
  form.hidden = !show;
  if (show) {
    const nameEl = document.getElementById('appsAddName');
    const pathEl = document.getElementById('appsAddPath');
    if (nameEl) nameEl.value = '';
    if (pathEl) pathEl.value = '';
    if (nameEl) nameEl.focus();
  }
}
function appsSubmitAdd() {
  const nameEl = document.getElementById('appsAddName');
  const pathEl = document.getElementById('appsAddPath');
  const name = (nameEl?.value || '').trim();
  const path = (pathEl?.value || '').trim();
  if (!path) {
    if (typeof toast === 'function') toast('Path is required.', 'warning');
    return;
  }
  const list = _appsLoadManual();
  if (list.some(a => a.path.toLowerCase() === path.toLowerCase())) {
    if (typeof toast === 'function') toast('Already added.', 'info');
    return;
  }
  const finalName = name || path.split(/[\\/]/).pop().replace(/\.exe$/i, '') || 'App';
  list.push({
    name: finalName,
    path
  });
  _appsSaveManual(list);
  appsToggleAddForm(false);
  appsSetLauncherSection('manual');
}
function appsRemoveManual(key) {
  const path = key.replace(/^man:/, '');
  const list = _appsLoadManual().filter(a => a.path !== path);
  _appsSaveManual(list);
  appsRenderLauncher();
}
function _appsUpdateStartButtonForFollowUp(followUp) {
  _appsSyncComposerMode();
}

// Compute the current chat composer mode from session state and paint the
// Send button + placeholder accordingly. Modes:
//   - start:     no session yet -> first Start creates it
//   - continue:  session exists but finished -> follow-up task
//   - running:   session is executing -> Send queues a mid-run note
//   - answering: agent called ask_user -> answer it
function _appsComposerMode() {
  if (_appsState.pendingAsk) return 'answering';
  if (_appsState.running) return 'running';
  if (_appsState.sessionId) return 'continue';
  return 'start';
}
function _appsSyncComposerMode() {
  const input = document.getElementById('appsChatInput');
  const send = document.getElementById('appsChatSendBtn');
  const interrupt = document.getElementById('appsInterruptBtn');
  if (!input || !send) return;
  const mode = _appsComposerMode();
  const meta = {
    start: {
      label: 'Start',
      placeholder: 'Describe what the AI should do in the selected app...'
    },
    continue: {
      label: 'Continue',
      placeholder: 'Add a follow-up task for the same app, or paste more context...'
    },
    running: {
      label: 'Send',
      placeholder: 'Send a note to the running agent (it will read it on the next turn)...'
    },
    answering: {
      label: 'Answer',
      placeholder: 'Type your answer to the AI...'
    }
  }[mode];
  let label = meta.label;
  let placeholder = meta.placeholder;
  if (_appsState.selectedRecipeId && (mode === 'start' || mode === 'continue')) {
    label = 'Run automation';
    placeholder = 'Running "' + (_appsState.selectedRecipeName || 'automation') + '" - type any extra notes or leave blank...';
  }
  send.textContent = label;
  input.placeholder = placeholder;
  if (interrupt) interrupt.style.display = _appsState.running ? '' : 'none';
  _appsRenderRecipeChip();
}
function _appsRenderRecipeChip() {
  const composer = document.getElementById('appsChatComposer');
  if (!composer) return;
  let chip = document.getElementById('appsSelectedRecipeChip');
  if (!_appsState.selectedRecipeId) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'appsSelectedRecipeChip';
    chip.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;margin:0 0 6px 0;background:color-mix(in srgb, var(--accent) 14%, transparent);border:1px solid color-mix(in srgb, var(--accent) 40%, transparent);border-radius:5px;font:11px var(--font-ui);color:var(--text);';
    composer.parentNode.insertBefore(chip, composer);
  }
  const stepThroughChecked = _appsState.stepThrough ? 'checked' : '';
  chip.innerHTML = '<i data-lucide="zap" style="width:11px;height:11px;color:var(--accent);"></i>' + '<span>Will run automation: <strong>' + _appsEscape(_appsState.selectedRecipeName || '') + '</strong></span>' + '<label class="sy-switch-row" style="margin-left:10px;color:var(--subtext1);" title="When on, the run pauses after every step and waits for you to hit Resume - useful for debugging. Off by default.">' + '<span class="sy-switch"><input type="checkbox" ' + stepThroughChecked + ' onchange="_appsToggleStepThrough(this.checked)"><span></span></span>' + 'Pause after each step' + '</label>' + '<button type="button" onclick="appsClearSelectedRecipe()" title="Clear selection" style="margin-left:auto;background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:2px 6px;font:11px var(--font-ui);">clear</button>';
  if (typeof lucide !== 'undefined') lucide.createIcons({
    el: chip
  });
}
function _appsToggleStepThrough(on) {
  _appsState.stepThrough = !!on;
}
async function appsResumeStep() {
  if (!_appsState.sessionId) return;
  try {
    await fetch('/api/apps/session/debug', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: _appsState.sessionId,
        action: 'resume'
      })
    });
  } catch (e) {
    if (typeof toast === 'function') toast('Resume failed: ' + e.message, 'error');
  }
}
async function appsRunToEnd() {
  if (!_appsState.sessionId) return;
  // Turn off step-through for the rest of this run, then release the gate.
  try {
    await fetch('/api/apps/session/debug', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: _appsState.sessionId,
        action: 'disable-step-through'
      })
    });
    _appsState.stepThrough = false;
    _appsSyncComposerMode();
    if (typeof toast === 'function') toast('Pause-after-each-step disabled. Running to end.', 'info', {
      duration: 2000
    });
  } catch (e) {
    if (typeof toast === 'function') toast('Run-to-end failed: ' + e.message, 'error');
  }
}
function _appsAutoresizeChatInput() {
  const el = document.getElementById('appsChatInput');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(140, el.scrollHeight) + 'px';
}
function appsChatKeydown(ev) {
  _appsAutoresizeChatInput();
  // Enter sends, Shift+Enter inserts a newline.
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    appsChatSend();
  }
}
async function appsChatSend() {
  const input = document.getElementById('appsChatInput');
  if (!input) return;
  const text = (input.value || '').trim();
  const mode = _appsComposerMode();
  // With an automation armed, an empty message is fine - the recipe IS the
  // goal. Everywhere else we still require text.
  const recipeArmed = !!_appsState.selectedRecipeId && (mode === 'start' || mode === 'continue');
  if (!text && !recipeArmed) return;
  if (mode === 'answering') {
    // Resolve the pending ask_user. Visual feedback comes from the backend.
    try {
      await fetch('/api/apps/session/answer', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: _appsState.sessionId,
          answer: text
        })
      });
      input.value = '';
      _appsAutoresizeChatInput();
      _appsState.pendingAsk = false;
      _appsSyncComposerMode();
    } catch (e) {
      if (typeof toast === 'function') toast('Send failed: ' + e.message, 'error');
    }
    return;
  }
  if (mode === 'running') {
    // Mid-run user message. The backend routes it to the active session's
    // ask_user queue (if the agent is paused waiting for input) or injects
    // it as a new user turn the agent will pick up on its next iteration.
    _appsAppendLog({
      kind: 'user',
      text: 'You: ' + text,
      klass: 'rationale'
    });
    input.value = '';
    _appsAutoresizeChatInput();
    try {
      await fetch('/api/apps/session/inject', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: _appsState.sessionId,
          message: text
        })
      });
    } catch (e) {
      if (typeof toast === 'function') toast('Send failed: ' + e.message, 'error');
    }
    return;
  }
  // mode === 'start' or 'continue'. A pending launch spec counts as
  // "app selected" - _appsStartWithGoal will open it before session/start.
  if (!_appsState.hwnd && !_appsState.pendingLaunchSpec) {
    if (typeof toast === 'function') toast('Pick an app first.', 'warning');
    return;
  }
  input.value = '';
  _appsAutoresizeChatInput();
  _appsAppendLog({
    kind: 'user',
    text: 'You: ' + text,
    klass: 'rationale'
  });
  if (mode === 'continue') {
    await _appsContinueWithGoal(text);
  } else {
    await _appsStartWithGoal(text);
  }
}
async function appsInterrupt() {
  if (!_appsState.sessionId || !_appsState.running) return;
  try {
    await fetch('/api/apps/session/stop', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: _appsState.sessionId
      })
    });
  } catch (_) {}
}
function _appsShowAskPrompt(question) {
  const list = document.getElementById('appsLogList');
  if (!list) return;
  // Remove any prior ask row so we only ever have one pending question.
  const prior = list.querySelector('.apps-log-ask');
  if (prior) prior.remove();
  const row = document.createElement('div');
  row.className = 'apps-log-entry apps-log-ask';
  row.style.cssText = 'border:1px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); padding: 8px; border-radius: 6px; margin-bottom: 4px;';
  row.innerHTML = '<div style="font:600 10px var(--font-ui); color: var(--accent); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 4px;">AI asks</div>' + '<div style="color: var(--text); font: 12px var(--font-ui); margin-bottom: 6px;">' + _appsEscape(question) + '</div>' + '<div style="display:flex; gap: 6px;">' + '<input type="text" class="apps-ask-input" placeholder="Type your answer..." style="flex:1; background: var(--surface0); color: var(--text); border: 1px solid var(--surface2); border-radius: 4px; padding: 5px 8px; font: 12px var(--font-ui);">' + '<button class="sy-btn sy-btn-primary apps-ask-send" style="height: 28px;">Send</button>' + '</div>';
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  const input = row.querySelector('.apps-ask-input');
  const btn = row.querySelector('.apps-ask-send');
  const send = async () => {
    const answer = (input.value || '').trim();
    if (!answer) return;
    btn.disabled = true;
    input.disabled = true;
    try {
      await fetch('/api/apps/session/answer', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: _appsState.sessionId,
          answer
        })
      });
      row.remove();
    } catch (e) {
      btn.disabled = false;
      input.disabled = false;
      if (typeof toast === 'function') toast('Send failed: ' + e.message, 'error');
    }
  };
  btn.addEventListener('click', send);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });
  setTimeout(() => input.focus(), 50);
}
async function _appsContinueWithGoal(goal) {
  try {
    const r = await fetch('/api/apps/session/continue', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: _appsState.sessionId,
        goal,
        provider: _appsState.providerKey || undefined
      })
    });
    const data = await r.json();
    if (!data.ok) {
      if (typeof toast === 'function') toast('Apps: ' + (data.error || 'continue failed'), 'error');
      return;
    }
    _appsState.running = true;
    _appsState.provider = data.label || data.provider || _appsState.provider || null;
    _appsState.model = data.model || _appsState.model || null;
    _appsUpdateRunningChrome(true);
    _appsSyncComposerMode();
  } catch (e) {
    if (typeof toast === 'function') toast('Apps: ' + e.message, 'error');
  }
}
async function _appsStartWithGoal(goal) {
  // If the user picked an app from the launcher but we deferred the actual
  // launch, open it now so the agent has a window to focus on.
  if (_appsState.pendingLaunchSpec) {
    const ok = await _appsLaunchIfPending();
    if (!ok) return;
  }
  if (!_appsState.hwnd) {
    if (typeof toast === 'function') toast('Pick an app first.', 'warning');
    return;
  }
  const img = document.getElementById('appsViewportImg');
  if (img) {
    img.style.display = 'none';
    img.src = '';
  }
  const empty = document.getElementById('appsViewportEmpty');
  if (empty) empty.style.display = 'block';
  _appsRenderPlan([], null);
  _appsState.lastRationale = null;
  _appsState.rationaleEl = null;
  const recipeId = _appsState.selectedRecipeId || undefined;
  const appKey = _appsInstructionsKey() || _appsState.app;
  let runInputs = null;
  if (recipeId && Array.isArray(_appsState.selectedRecipeInputDefs) && _appsState.selectedRecipeInputDefs.length) {
    runInputs = await _appsCollectInputs({
      name: _appsState.selectedRecipeName,
      inputs: _appsState.selectedRecipeInputDefs
    });
    if (runInputs == null) {
      if (typeof toast === 'function') toast('Cancelled.', 'info');
      return;
    }
  }
  try {
    const r = await fetch('/api/apps/session/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        goal: recipeId ? undefined : goal,
        recipeId,
        inputs: runInputs || undefined,
        stepThrough: recipeId ? !!_appsState.stepThrough : undefined,
        hwnd: _appsState.hwnd,
        app: appKey,
        provider: _appsState.providerKey || undefined
      })
    });
    const data = await r.json();
    if (!data.ok) {
      if (typeof toast === 'function') toast('Apps: ' + (data.error || 'start failed'), 'error');
      return;
    }
    _appsState.sessionId = data.sessionId;
    _appsState.running = true;
    _appsState.provider = data.label || data.provider || null;
    _appsState.model = data.model || null;
    _appsUpdateRunningChrome(true);
    _appsSyncComposerMode();
  } catch (e) {
    if (typeof toast === 'function') toast('Apps: ' + e.message, 'error');
  }
}
async function appsStop() {
  if (!_appsState.sessionId) return;
  try {
    await fetch('/api/apps/session/stop', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: _appsState.sessionId
      })
    });
  } catch (_) {}
}
async function appsPanic() {
  try {
    await fetch('/api/apps/panic', {
      method: 'POST'
    });
  } catch (_) {}
  if (typeof toast === 'function') toast('Apps agent panic stopped.', 'warning');
}
async function appsReset() {
  // Stop an in-flight session (if any) before clearing UI so backend and
  // frontend don't disagree about who is running.
  if (_appsState.sessionId && _appsState.running) {
    try {
      await fetch('/api/apps/session/stop', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: _appsState.sessionId
        })
      });
    } catch (_) {}
  }
  // Clear every composer / picker / legacy input so the tab is truly blank.
  const goalLegacy = document.getElementById('appsGoalInput');
  if (goalLegacy) goalLegacy.value = '';
  const chatInput = document.getElementById('appsChatInput');
  if (chatInput) {
    chatInput.value = '';
    chatInput.style.height = '';
  }
  const log = document.getElementById('appsLogList');
  if (log) log.innerHTML = '';
  const img = document.getElementById('appsViewportImg');
  if (img) {
    img.style.display = 'none';
    img.src = '';
  }
  const empty = document.getElementById('appsViewportEmpty');
  if (empty) empty.style.display = 'block';
  _appsRenderPlan([], null);
  // Drop the selected app too — the whole tab resets to "pick an app" state.
  _appsState.sessionId = null;
  _appsState.running = false;
  _appsState.provider = null;
  _appsState.model = null;
  _appsState.hwnd = null;
  _appsState.title = null;
  _appsState.app = null;
  _appsState.pendingAsk = false;
  _appsState.lastRationale = null;
  _appsState.rationaleEl = null;
  _appsState.pendingLaunchSpec = null;
  _appsState.selectedRecipeId = null;
  _appsState.selectedRecipeName = null;
  _appsState.recipes = [];
  _appsRenderRecipeChip();
  const pickerLabel = document.getElementById('appsPickerLabel');
  if (pickerLabel) pickerLabel.textContent = 'Pick an app...';
  const insBtn = document.getElementById('appsInstructionsBtn');
  if (insBtn) insBtn.style.display = 'none';
  const autoBtn = document.getElementById('appsAutomationsBtn');
  if (autoBtn) autoBtn.style.display = 'none';
  _appsUpdateRunningChrome(false);
  if (typeof _appsUpdateStartButtonForFollowUp === 'function') _appsUpdateStartButtonForFollowUp(false);
}
function _appsUpdateRunningChrome(running) {
  const banner = document.getElementById('appsBanner');
  if (banner) banner.classList.toggle('on', !!running);
  const head = document.getElementById('appsLogHead');
  if (head) head.classList.toggle('running', !!running);
  const title = document.getElementById('appsLogTitle');
  if (title) title.textContent = running ? 'Chat (live)' : 'Chat';
  const saveBtn = document.getElementById('appsSaveAsAutomationBtn');
  // Only show "Save as Automation" during free-form sessions (no recipe
  // armed) since replaying a recipe back to itself is noise.
  if (saveBtn) saveBtn.style.display = running && !_appsState.selectedRecipeId ? '' : 'none';
  if (typeof _appsSyncComposerMode === 'function') _appsSyncComposerMode();
  const modelBadge = document.getElementById('appsLogModel');
  if (modelBadge) {
    if (running && (_appsState.model || _appsState.provider)) {
      modelBadge.style.display = '';
      modelBadge.textContent = [_appsState.provider, _appsState.model].filter(Boolean).join(' · ');
    } else {
      modelBadge.style.display = 'none';
      modelBadge.textContent = '';
    }
  }
}
function _appsAppendLog({
  kind,
  text,
  klass,
  pre
}) {
  const list = document.getElementById('appsLogList');
  if (!list) return null;
  const el = document.createElement('div');
  el.className = 'apps-log-entry ' + (klass || kind || '');
  const kindBadge = kind ? '<span class="apps-log-kind">' + _appsEscape(kind) + '</span>' : '';
  const body = text ? _appsEscape(text) : '';
  const preBlock = pre ? '<pre>' + _appsEscape(pre) + '</pre>' : '';
  el.innerHTML = kindBadge + body + preBlock;
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
  return el;
}
function _appsRenderPlan(subgoals, activeId) {
  const host = document.getElementById('appsPlanList');
  if (!host) return;
  if (!subgoals.length) {
    host.innerHTML = '<div class="apps-plan-empty">Subgoals appear here after you start a session.</div>';
    return;
  }
  const mark = s => s.status === 'done' ? '&#10003;' : s.status === 'active' ? '&#9658;' : s.status === 'blocked' ? '!' : s.status === 'skipped' ? '&mdash;' : '';
  host.innerHTML = subgoals.map(s => {
    const attempts = s.attempts && s.status === 'active' ? 'Attempt ' + s.attempts : '';
    return '<div class="apps-subgoal ' + _appsEscape(s.status || 'pending') + '">' + '<span class="apps-subgoal-mark">' + mark(s) + '</span>' + '<span class="apps-subgoal-title">' + _appsEscape(s.title || '') + (s.completionCheck ? '<span class="apps-subgoal-check">done when: ' + _appsEscape(s.completionCheck) + '</span>' : '') + (attempts ? '<span class="apps-subgoal-attempts">' + attempts + '</span>' : '') + '</span>' + '</div>';
  }).join('');
}
function _appsShowClickDot(at, rect) {
  if (!at || !rect || rect.w <= 0 || rect.h <= 0) return;
  const viewport = document.getElementById('appsViewport');
  const img = document.getElementById('appsViewportImg');
  if (!viewport || !img || img.style.display === 'none') return;
  // Coordinates that come back from click() are absolute-screen. Translate
  // them back to window-relative using the last known rect, then map to
  // displayed image pixels.
  const winX = at.x - rect.x;
  const winY = at.y - rect.y;
  if (winX < 0 || winY < 0 || winX > rect.w || winY > rect.h) return;
  const ir = img.getBoundingClientRect();
  const vr = viewport.getBoundingClientRect();
  // object-fit: contain — compute the actual content rect inside the img box.
  const scale = Math.min(ir.width / rect.w, ir.height / rect.h);
  const drawnW = rect.w * scale;
  const drawnH = rect.h * scale;
  const offX = (ir.width - drawnW) / 2 + (ir.left - vr.left);
  const offY = (ir.height - drawnH) / 2 + (ir.top - vr.top);
  const dot = document.createElement('div');
  dot.className = 'apps-click-dot';
  dot.style.left = offX + winX * scale + 'px';
  dot.style.top = offY + winY * scale + 'px';
  viewport.appendChild(dot);
  setTimeout(() => {
    try {
      dot.remove();
    } catch (_) {}
  }, 900);
}
state._appsLastRect = null; // Headless Office (COM) modal — tiny dialog launched from the hero card on
// the empty viewport. Lets the user generate a Word or Excel file via
// /api/apps/com/* without writing curl. Output path defaults to the user's
// Documents folder.
function _appsHeroOpenComModal() {
  let overlay = document.getElementById('appsComModal');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'appsComModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3300;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove();
  };
  const docs = 'C:\\Users\\' + (navigator.userAgent.includes('Win') ? '<you>' : '<you>') + '\\Documents';
  overlay.innerHTML = '<div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:10px;width:600px;max-width:94vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);padding:18px 22px;">' + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">' + '<i data-lucide="file-text" style="width:17px;height:17px;color:var(--accent);"></i>' + '<strong style="font-size:14px;">Headless Office (COM)</strong>' + '<div style="flex:1;"></div>' + '<button onclick="document.getElementById(\'appsComModal\').remove()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;font-size:16px;line-height:1;">&times;</button>' + '</div>' + '<div style="font-size:12px;color:var(--subtext1);margin-bottom:14px;">Generates the file directly via Word.Application / Excel.Application COM. No window paints. The file is written to disk.</div>' + '<div style="display:flex;gap:6px;margin-bottom:12px;">' + '<button class="sy-btn sy-btn-outline" type="button" id="appsComMode-word" onclick="_appsComSetMode(\'word\')">Word .docx</button>' + '<button class="sy-btn sy-btn-outline" type="button" id="appsComMode-excel" onclick="_appsComSetMode(\'excel\')">Excel .xlsx</button>' + '</div>' + '<label style="display:block;font-size:11px;color:var(--subtext0);margin-bottom:4px;">File path</label>' + '<input type="text" id="appsComPath" placeholder="C:\\Users\\you\\Documents\\report.docx" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--surface2);background:var(--surface1);color:var(--text);font:12px var(--font-mono);margin-bottom:12px;">' + '<label style="display:block;font-size:11px;color:var(--subtext0);margin-bottom:4px;" id="appsComBodyLabel">Document content</label>' + '<textarea id="appsComBody" placeholder="Title\n\nFirst paragraph..." style="width:100%;height:160px;padding:10px;border-radius:6px;border:1px solid var(--surface2);background:var(--surface1);color:var(--text);font:12px var(--font-mono);margin-bottom:8px;resize:vertical;"></textarea>' + '<div style="font-size:11px;color:var(--subtext0);margin-bottom:14px;display:none;" id="appsComExcelHint">' + 'For Excel: paste a 2D JSON array (rows of cells). Use <code style="background:var(--surface2);padding:1px 4px;border-radius:3px;">"=SUM(B2:B3)"</code> for formulas. Numbers as numbers.' + '</div>' + '<div style="display:flex;justify-content:flex-end;gap:8px;">' + '<button class="sy-btn sy-btn-ghost" type="button" onclick="document.getElementById(\'appsComModal\').remove()">Cancel</button>' + '<button class="sy-btn sy-btn-primary" type="button" onclick="_appsComSubmit()" id="appsComSubmitBtn">Generate</button>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  if (typeof lucide !== 'undefined') lucide.createIcons({
    el: overlay
  });
  _appsComSetMode('word');
}
state._appsComMode = 'word';
function _appsComSetMode(mode) {
  state._appsComMode = mode;
  const wordBtn = document.getElementById('appsComMode-word');
  const xlBtn = document.getElementById('appsComMode-excel');
  if (wordBtn && xlBtn) {
    wordBtn.classList.toggle('sy-btn-primary', mode === 'word');
    wordBtn.classList.toggle('sy-btn-outline', mode !== 'word');
    xlBtn.classList.toggle('sy-btn-primary', mode === 'excel');
    xlBtn.classList.toggle('sy-btn-outline', mode !== 'excel');
  }
  const label = document.getElementById('appsComBodyLabel');
  const body = document.getElementById('appsComBody');
  const hint = document.getElementById('appsComExcelHint');
  const path = document.getElementById('appsComPath');
  if (mode === 'word') {
    if (label) label.textContent = 'Document content (paragraphs separated by newlines)';
    if (hint) hint.style.display = 'none';
    if (body && !body.value) body.placeholder = 'Title\n\nFirst paragraph.\nSecond paragraph.';
    if (path && !path.value) path.value = '';
  } else {
    if (label) label.textContent = 'Excel data (2D JSON array)';
    if (hint) hint.style.display = '';
    if (body && !body.value) body.placeholder = '[\n  ["Customer", "Deal Value"],\n  ["ACME", 12500],\n  ["Globex", 8400],\n  ["TOTAL", "=SUM(B2:B3)"]\n]';
    if (path && !path.value) path.value = '';
  }
}
async function _appsComSubmit() {
  const path = (document.getElementById('appsComPath') || {}).value || '';
  const body = (document.getElementById('appsComBody') || {}).value || '';
  if (!path) {
    if (typeof toast === 'function') toast('File path required.', 'warning');
    return;
  }
  const btn = document.getElementById('appsComSubmitBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating...';
  }
  try {
    let route, payload;
    if (state._appsComMode === 'word') {
      route = '/api/apps/com/word/write';
      payload = {
        filePath: path,
        content: body
      };
    } else {
      let values;
      try {
        values = JSON.parse(body);
      } catch (e) {
        throw new Error('Excel body must be valid JSON 2D array: ' + e.message);
      }
      if (!Array.isArray(values) || !values.length || !Array.isArray(values[0])) throw new Error('Excel body must be an array of arrays');
      route = '/api/apps/com/excel/write';
      payload = {
        filePath: path,
        values
      };
    }
    const r = await fetch(route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'COM call failed');
    if (typeof notify === 'function') notify('Apps COM ' + state._appsComMode + ' done', 'Wrote ' + path, {
      source: 'apps-com',
      icon: 'file-text'
    });
    if (typeof toast === 'function') toast('Saved ' + path, 'success', {
      duration: 4000
    });
    document.getElementById('appsComModal').remove();
  } catch (e) {
    if (typeof toast === 'function') toast('COM: ' + e.message, 'error', {
      duration: 5000
    });
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Generate';
    }
  }
}

// Multi-session tracker: stealth automation makes parallel runs viable, so
// the Apps tab can no longer assume a single session. Each session id seen
// on a WS frame gets its own bookkeeping entry; the user clicks chips in
// the strip to switch which session is "active" (the one whose viewport +
// log is shown below). The existing single-session UI plumbing is left
// intact — it just renders whichever session is currently active.
var _appsSessions = new Map(); // sessionId -> { id, app, title, hwnd, status, lastActionAt, lastSummary }
state._appsActiveSessionId = null;
function _appsRegisterSession(msg) {
  if (!msg || !msg.sessionId) return null;
  const id = msg.sessionId;
  let s = _appsSessions.get(id);
  if (!s) {
    s = {
      id,
      app: msg.app || _appsState.app || null,
      title: msg.title || _appsState.title || null,
      hwnd: msg.hwnd || _appsState.hwnd || null,
      status: 'running',
      startedAt: Date.now(),
      lastActionAt: Date.now(),
      lastSummary: null
    };
    _appsSessions.set(id, s);
    if (!state._appsActiveSessionId) state._appsActiveSessionId = id;
    _appsRenderSessionStrip();
    _appsUpdateTabRunningDot();
  }
  // Some events carry a fresher app/title (esp. early in the session).
  if (msg.app && !s.app) s.app = msg.app;
  if (msg.title && !s.title) s.title = msg.title;
  s.lastActionAt = Date.now();
  return s;
}
function _appsMarkSessionStatus(sessionId, status, summary) {
  const s = _appsSessions.get(sessionId);
  if (!s) return;
  s.status = status;
  if (summary) s.lastSummary = summary;
  s.endedAt = Date.now();
  _appsRenderSessionStrip();
  _appsUpdateTabRunningDot();
}
function _appsSwitchActiveSession(sessionId) {
  if (!_appsSessions.has(sessionId)) return;
  state._appsActiveSessionId = sessionId;
  const s = _appsSessions.get(sessionId);
  // Repoint the singleton _appsState to this session so the existing log /
  // viewport / running chrome track the newly-active session. We do NOT
  // replay history; the user gets a fresh view from this point forward.
  _appsState.sessionId = sessionId;
  _appsState.hwnd = s.hwnd || null;
  _appsState.title = s.title || null;
  _appsState.app = s.app || null;
  _appsState.running = s.status === 'running';
  // If we drop to a single-session view, switch the viewport back to the
  // big single image and seed it with this session's last screenshot.
  if (_appsSessions.size <= 1) {
    const grid = document.getElementById('appsViewportGrid');
    const singleImg = document.getElementById('appsViewportImg');
    const empty = document.getElementById('appsViewportEmpty');
    if (grid) {
      grid.hidden = true;
      grid.innerHTML = '';
    }
    if (singleImg && s.lastScreenshot) {
      singleImg.src = s.lastScreenshot;
      singleImg.style.display = '';
      if (empty) empty.style.display = 'none';
    }
  }
  _appsRenderSessionStrip();
  if (typeof _appsUpdateRunningChrome === 'function') _appsUpdateRunningChrome(_appsState.running);
  // Clear the log since it was full of the previous session's events.
  const list = document.getElementById('appsLogList');
  if (list) list.innerHTML = '';
  _appsAppendLog({
    kind: 'info',
    text: 'Switched to session ' + sessionId + ' (' + (s.app || s.title || '?') + ')',
    klass: 'memory'
  });
}
function _appsCloseSession(sessionId) {
  _appsSessions.delete(sessionId);
  if (state._appsActiveSessionId === sessionId) {
    // Pick another session if any exist, else clear.
    const next = _appsSessions.keys().next();
    state._appsActiveSessionId = next.done ? null : next.value;
    if (state._appsActiveSessionId) _appsSwitchActiveSession(state._appsActiveSessionId);else {
      _appsState.sessionId = null;
      const list = document.getElementById('appsLogList');
      if (list) list.innerHTML = '';
    }
  }
  _appsRenderSessionStrip();
  _appsUpdateTabRunningDot();
}
function _appsRenderSessionStrip() {
  const strip = document.getElementById('appsSessionsStrip');
  if (!strip) return;
  if (_appsSessions.size === 0) {
    strip.hidden = true;
    strip.innerHTML = '';
    _appsRenderViewportGrid();
    return;
  }
  strip.hidden = false;
  const sessions = Array.from(_appsSessions.values()).sort((a, b) => a.startedAt - b.startedAt);
  strip.innerHTML = sessions.map(s => {
    const cls = ['apps-session-chip'];
    if (s.id === state._appsActiveSessionId) cls.push('active');
    if (s.status === 'done') cls.push('done');
    if (s.status === 'error' || s.status === 'panic' || s.status === 'stopped') cls.push('error');
    const label = _appsEscape(s.app || s.title || s.id.slice(0, 16));
    return '<div class="' + cls.join(' ') + '" data-sid="' + _appsEscape(s.id) + '" title="' + _appsEscape(s.id) + ' — ' + (s.status || 'running') + '">' + '<span class="chip-status-dot"></span>' + '<span class="chip-app">' + label + '</span>' + '<button class="chip-close" type="button" title="Remove from list">&times;</button>' + '</div>';
  }).join('');
  // Wire click handlers (delegation kept simple).
  strip.querySelectorAll('.apps-session-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      if (e.target.classList.contains('chip-close')) {
        e.stopPropagation();
        _appsCloseSession(chip.dataset.sid);
        return;
      }
      _appsSwitchActiveSession(chip.dataset.sid);
    });
  });
  _appsRenderViewportGrid();
}

// Render the multi-session viewport grid. Tiles show each session's most
// recent screenshot, status-coded border, click-to-activate. The grid is
// shown when 2+ sessions are tracked; with 1 session we keep the single
// big-image view (less visual noise for the common case).
function _appsRenderViewportGrid() {
  const grid = document.getElementById('appsViewportGrid');
  const singleImg = document.getElementById('appsViewportImg');
  const empty = document.getElementById('appsViewportEmpty');
  if (!grid) return;
  const sessions = Array.from(_appsSessions.values()).sort((a, b) => a.startedAt - b.startedAt);
  if (sessions.length < 2) {
    grid.hidden = true;
    grid.innerHTML = '';
    grid.removeAttribute('data-count');
    return;
  }
  // Multi-session mode: hide the single-image view, show grid.
  grid.hidden = false;
  if (singleImg) singleImg.style.display = 'none';
  if (empty) empty.style.display = 'none';
  grid.setAttribute('data-count', String(Math.min(sessions.length, 6)));
  grid.innerHTML = sessions.map(s => {
    const cls = ['apps-viewport-tile'];
    if (s.id === state._appsActiveSessionId) cls.push('active');
    if (s.status === 'done') cls.push('done');
    if (s.status === 'error' || s.status === 'panic' || s.status === 'stopped') cls.push('error');
    const label = _appsEscape(s.app || s.title || s.id.slice(0, 12));
    const img = s.lastScreenshot ? '<img src="' + s.lastScreenshot + '" alt="' + label + '">' : '<span class="tile-empty">No screenshot yet</span>';
    return '<div class="' + cls.join(' ') + '" data-sid="' + _appsEscape(s.id) + '">' + '<div class="apps-viewport-tile-head">' + '<span class="tile-status"></span>' + '<span class="tile-label">' + label + '</span>' + '<span style="font:10px var(--font-mono);color:var(--subtext0);">' + (s.status || 'running') + '</span>' + '</div>' + '<div class="apps-viewport-tile-img-wrap">' + img + '</div>' + '</div>';
  }).join('');
  grid.querySelectorAll('.apps-viewport-tile').forEach(tile => {
    tile.addEventListener('click', () => _appsSwitchActiveSession(tile.dataset.sid));
  });
}
function _appsUpdateTabRunningDot() {
  const btn = document.getElementById('appsTabBtn');
  if (!btn) return;
  const anyRunning = Array.from(_appsSessions.values()).some(s => s.status === 'running');
  btn.classList.toggle('has-running', anyRunning);
}
function handleAppsAgentStep(msg) {
  if (!msg) return;
  // First: register / update the per-session tracker on every event that
  // carries a sessionId. This is what powers the strip + tab dot.
  if (msg.sessionId) _appsRegisterSession(msg);
  // Only render into the visible UI for events belonging to the active
  // session. Background sessions still affect the strip + dot but don't
  // flood the active log.
  if (msg.sessionId && state._appsActiveSessionId && msg.sessionId !== state._appsActiveSessionId) {
    // Still need to track terminal states so the chip flips color.
    if (msg.kind === 'done') _appsMarkSessionStatus(msg.sessionId, 'done', msg.summary || null);else if (msg.kind === 'stopped') _appsMarkSessionStatus(msg.sessionId, 'stopped');else if (msg.kind === 'error') _appsMarkSessionStatus(msg.sessionId, 'error', msg.message || null);else if (msg.kind === 'panic') _appsMarkSessionStatus(msg.sessionId, 'panic');
    // Bell notification fires regardless of which session was active.
    if ((msg.kind === 'done' || msg.kind === 'error') && typeof notify === 'function') {
      const s = _appsSessions.get(msg.sessionId) || {};
      const appLabel = s.app || s.title || msg.sessionId;
      const sev = msg.kind === 'error' ? 'error' : 'info';
      notify('Apps: ' + appLabel + ' ' + msg.kind, String(msg.summary || msg.message || '').slice(0, 240), {
        source: 'apps-agent',
        icon: 'monitor',
        severity: sev
      });
    }
    return;
  }
  // For ANY session (active or background), capture screenshot frames
  // into the per-session record so the multi-session grid stays live.
  // The active session also goes through the existing single-img viewport
  // path below.
  if (msg.kind === 'screenshot' && msg.sessionId && msg.base64) {
    const s = _appsSessions.get(msg.sessionId);
    if (s) {
      s.lastScreenshot = 'data:' + (msg.mimeType || 'image/jpeg') + ';base64,' + msg.base64;
      // Cheap re-render: rather than touching the whole grid, update just
      // this tile's <img>. Falls back to full re-render if the tile
      // doesn't exist yet (first frame for a brand-new session).
      const tile = document.querySelector('.apps-viewport-tile[data-sid="' + CSS.escape(msg.sessionId) + '"]');
      if (tile) {
        const wrap = tile.querySelector('.apps-viewport-tile-img-wrap');
        if (wrap) {
          wrap.innerHTML = '<img src="' + s.lastScreenshot + '" alt="">';
        }
      } else {
        _appsRenderViewportGrid();
      }
    }
  }
  const kind = msg.kind;
  if (kind === 'token') {
    // Stream text into the current rationale entry.
    if (!_appsState.rationaleEl) {
      _appsState.rationaleEl = _appsAppendLog({
        kind: 'thinking',
        text: '',
        klass: 'rationale'
      });
      _appsState.lastRationale = '';
    }
    _appsState.lastRationale = (_appsState.lastRationale || '') + (msg.text || '');
    _appsState.rationaleEl.innerHTML = '<span class="apps-log-kind">thinking</span>' + _appsEscape(_appsState.lastRationale);
    const list = document.getElementById('appsLogList');
    if (list) list.scrollTop = list.scrollHeight;
    return;
  }
  if (kind === 'message') {
    // Finalize the streamed rationale (or create one if the provider
    // skipped token events).
    if (!_appsState.rationaleEl && msg.text) {
      _appsAppendLog({
        kind: 'thinking',
        text: msg.text,
        klass: 'rationale'
      });
    }
    _appsState.rationaleEl = null;
    _appsState.lastRationale = null;
    return;
  }
  if (kind === 'action') {
    _appsState.rationaleEl = null;
    _appsState.lastRationale = null;
    var klass = 'action';
    if (msg.tool === 'write_memory') klass = 'memory';
    _appsAppendLog({
      kind: msg.tool === 'write_memory' ? 'memory' : 'action',
      text: msg.summary || msg.tool,
      klass: klass
    });
    return;
  }
  if (kind === 'screenshot') {
    const img = document.getElementById('appsViewportImg');
    const empty = document.getElementById('appsViewportEmpty');
    if (img && msg.base64) {
      img.src = 'data:' + (msg.mimeType || 'image/jpeg') + ';base64,' + msg.base64;
      img.style.display = '';
      if (empty) empty.style.display = 'none';
    }
    if (msg.rect) state._appsLastRect = msg.rect;
    // Streaming frames (Gemini Live / OpenAI Realtime capture pump) update the
    // viewport only. Without this guard, a 2 fps pump floods the log with
    // thumbnail entries forever.
    if (msg.streaming) return;
    const entry = _appsAppendLog({
      kind: 'shot',
      klass: 'screenshot'
    });
    if (entry && img && img.src) {
      const thumb = document.createElement('img');
      thumb.src = img.src;
      thumb.title = 'Click to show in the main viewport';
      thumb.style.cursor = 'pointer';
      thumb.addEventListener('click', () => {
        const big = document.getElementById('appsViewportImg');
        if (big) {
          big.src = thumb.src;
          big.style.display = '';
        }
        const e = document.getElementById('appsViewportEmpty');
        if (e) e.style.display = 'none';
      });
      entry.appendChild(thumb);
      const caption = document.createElement('span');
      caption.style.color = 'var(--subtext0)';
      caption.style.fontSize = '10px';
      caption.textContent = (msg.width || '?') + 'x' + (msg.height || '?');
      entry.appendChild(caption);
    }
    return;
  }
  if (kind === 'observation') {
    if (msg.ok === false) {
      var codeHint = '';
      switch (msg.code) {
        case 'window_gone':
          codeHint = ' (the target window has closed; list windows and pick a new one)';
          break;
        case 'window_moved':
          codeHint = ' (the window moved since the last screenshot; take a fresh screenshot before clicking)';
          break;
        case 'deny_listed':
          codeHint = ' (window is on the safety deny list and cannot be driven)';
          break;
        case 'already_tried':
          codeHint = ' (exact same call was already rejected; try a different approach)';
          break;
        case 'note_too_large':
          codeHint = ' (memory note was too long; shorten to under 2KB)';
          break;
        case 'window_minimized':
          codeHint = ' (window was minimized; it should be restored automatically on the next tool call)';
          break;
      }
      _appsAppendLog({
        kind: 'err',
        text: (msg.tool || '?') + ': ' + (msg.error || 'failed') + (msg.code ? ' (' + msg.code + ')' : '') + codeHint,
        klass: 'observation err'
      });
    } else if (msg.preview) {
      _appsAppendLog({
        kind: 'result',
        text: msg.preview,
        klass: 'observation'
      });
    }
    return;
  }
  if (kind === 'stuck') {
    _appsAppendLog({
      kind: 'stuck',
      text: 'Stuck: ' + (msg.reason || ''),
      klass: 'stuck'
    });
    return;
  }
  if (kind === 'research') {
    _appsAppendLog({
      kind: 'research',
      text: 'Research notes arrived',
      klass: 'memory',
      pre: msg.summary || ''
    });
    return;
  }
  if (kind === 'recipe_started') {
    _appsAppendLog({
      kind: 'recipe',
      text: 'Automation: ' + (msg.name || '?') + ' (' + (msg.stepCount || 0) + ' steps)',
      klass: 'memory'
    });
    return;
  }
  if (kind === 'step_index') {
    // Don't spam the log with indices; they're just progress markers.
    return;
  }
  if (kind === 'step_info') {
    _appsAppendLog({
      kind: 'info',
      text: msg.message || '',
      klass: 'observation'
    });
    return;
  }
  if (kind === 'step_retry') {
    _appsAppendLog({
      kind: 'retry',
      text: 'Retrying step ' + ((msg.index || 0) + 1) + ': ' + (msg.reason || ''),
      klass: 'observation err'
    });
    return;
  }
  if (kind === 'step_failed') {
    _appsAppendLog({
      kind: 'fail',
      text: 'Step ' + ((msg.index || 0) + 1) + ' ' + (msg.verb || '') + ' failed: ' + (msg.reason || ''),
      klass: 'observation err'
    });
    return;
  }
  if (kind === 'step_done') {
    // Silent success marker; the screenshot broadcast right after carries the state visual.
    return;
  }
  if (kind === 'step_paused') {
    const entry = _appsAppendLog({
      kind: 'paused',
      text: 'Paused at step ' + ((msg.index || 0) + 1) + '. Pause-after-each-step is ON.',
      klass: 'memory'
    });
    if (entry) {
      const resume = document.createElement('button');
      resume.className = 'sy-btn sy-btn-outline';
      resume.style.cssText = 'margin-left:8px;height:22px;padding:0 10px;font-size:11px;';
      resume.textContent = 'Resume';
      resume.onclick = () => {
        appsResumeStep();
        resume.disabled = true;
        resume.textContent = 'Resuming...';
      };
      entry.appendChild(resume);
      const runAll = document.createElement('button');
      runAll.className = 'sy-btn sy-btn-primary';
      runAll.style.cssText = 'margin-left:6px;height:22px;padding:0 10px;font-size:11px;';
      runAll.textContent = 'Run to end';
      runAll.onclick = () => {
        appsRunToEnd();
        runAll.disabled = true;
        resume.disabled = true;
        runAll.textContent = 'Running...';
      };
      entry.appendChild(runAll);
    }
    return;
  }
  if (kind === 'step_resumed') {
    // Clean up any stale resume button rendered in an earlier paused row.
    const list = document.getElementById('appsLogList');
    if (list) list.querySelectorAll('.apps-log-entry.memory button.sy-btn').forEach(b => {
      if (b.textContent === 'Resuming...' || b.textContent === 'Resume') b.remove();
    });
    return;
  }
  if (kind === 'test_pass') {
    _appsAppendLog({
      kind: 'done',
      text: 'Test passed: ' + (msg.testName || '') + ' (' + (msg.durationMs || 0) + 'ms)',
      klass: 'done'
    });
    return;
  }
  if (kind === 'test_fail') {
    const reasons = (msg.failures || []).map(f => '- ' + f).join('\n');
    _appsAppendLog({
      kind: 'fail',
      text: 'Test failed: ' + (msg.testName || ''),
      klass: 'observation err',
      pre: reasons
    });
    return;
  }
  if (kind === 'memory_loaded') {
    const appLabel = msg.app || '(no app key)';
    const text = msg.bytes ? 'Instructions loaded for ' + appLabel + ' (' + msg.bytes + ' bytes' + (msg.hasInstructions ? ', custom Instructions present' : '') + ')' : 'No instructions file for ' + appLabel + '. Nothing was injected into the system prompt.';
    _appsAppendLog({
      kind: 'memory',
      text,
      klass: 'memory'
    });
    return;
  }
  if (kind === 'memory') {
    _appsAppendLog({
      kind: 'memory',
      text: '[' + (msg.section || '?') + '] ' + (msg.note || ''),
      klass: 'memory'
    });
    return;
  }
  if (kind === 'plan') {
    _appsRenderPlan(msg.subgoals || [], msg.activeId || null);
    return;
  }
  if (kind === 'ask') {
    _appsAppendLog({
      kind: 'ask',
      text: 'AI asks: ' + (msg.question || 'The AI needs your input.'),
      klass: 'stuck'
    });
    _appsState.pendingAsk = true;
    _appsSyncComposerMode();
    const input = document.getElementById('appsChatInput');
    if (input) setTimeout(() => input.focus(), 50);
    return;
  }
  if (kind === 'answer') {
    _appsState.pendingAsk = false;
    _appsSyncComposerMode();
    return;
  }
  if (kind === 'done') {
    _appsAppendLog({
      kind: 'done',
      text: (msg.summary || 'Done.') + '  (type a follow-up below to continue)',
      klass: 'done'
    });
    _appsState.running = false;
    if (msg.sessionId) _appsMarkSessionStatus(msg.sessionId, 'done', msg.summary || null);
    // Keep sessionId so the user can chain a follow-up task. The Start button
    // will route to /api/apps/session/continue instead of starting fresh.
    _appsUpdateRunningChrome(false);
    _appsUpdateStartButtonForFollowUp(true);
    // Bottom-right toast + success chime so the user knows the run is over
    // even if the Apps tab isn't focused.
    if (typeof toast === 'function') {
      const app = (_appsState.app || msg.app || '').trim();
      const summary = String(msg.summary || 'Automation completed.').replace(/\s+/g, ' ').slice(0, 200);
      toast(`Apps${app ? ': ' + app : ''} - ${summary}`, 'success', {
        duration: 5000
      });
    }
    // Persistent bell-panel notification so completed runs survive even
    // after the toast fades. This is what the user asked for explicitly:
    // "we also need a notification (in the notification bell)".
    if (typeof notify === 'function') {
      const app = (_appsState.app || msg.app || '').trim();
      const summary = String(msg.summary || 'Automation completed.').replace(/\s+/g, ' ').slice(0, 240);
      notify('Apps' + (app ? ': ' + app : '') + ' done', summary, {
        source: 'apps-agent',
        icon: 'monitor',
        severity: 'info'
      });
    }
    return;
  }
  if (kind === 'stopped') {
    _appsAppendLog({
      kind: 'stopped',
      text: 'Stopped.',
      klass: 'done'
    });
    _appsState.running = false;
    if (msg.sessionId) _appsMarkSessionStatus(msg.sessionId, 'stopped');
    _appsState.sessionId = null;
    _appsUpdateRunningChrome(false);
    _appsUpdateStartButtonForFollowUp(false);
    return;
  }
  if (kind === 'panic') {
    _appsAppendLog({
      kind: 'panic',
      text: 'Panic stop.',
      klass: 'error'
    });
    _appsState.running = false;
    if (msg.sessionId) _appsMarkSessionStatus(msg.sessionId, 'panic');
    _appsState.sessionId = null;
    _appsUpdateRunningChrome(false);
    _appsUpdateStartButtonForFollowUp(false);
    return;
  }
  if (kind === 'error') {
    _appsAppendLog({
      kind: 'error',
      text: msg.message || 'error',
      klass: 'error'
    });
    _appsState.running = false;
    if (msg.sessionId) _appsMarkSessionStatus(msg.sessionId, 'error', msg.message || null);
    _appsState.sessionId = null;
    _appsUpdateRunningChrome(false);
    if (typeof notify === 'function') {
      const app = (_appsState.app || msg.app || '').trim();
      notify('Apps' + (app ? ': ' + app : '') + ' error', String(msg.message || 'error').slice(0, 240), {
        source: 'apps-agent',
        icon: 'monitor',
        severity: 'error'
      });
    }
    return;
  }
}

// Draw the click dot when the agent issues a click. We do it on the
// `action` event where we have the window-relative coords.
(function wrapClickDot() {
  var orig = handleAppsAgentStep;
  handleAppsAgentStep = function (msg) {
    try {
      if (msg && msg.kind === 'action' && msg.tool === 'click' && state._appsLastRect && msg.args) {
        var rect = state._appsLastRect;
        var abs = {
          x: rect.x + (msg.args.x || 0),
          y: rect.y + (msg.args.y || 0)
        };
        _appsShowClickDot(abs, rect);
      }
    } catch (_) {}
    return orig(msg);
  };
})();// ── Browser Agent chat panel ──────────────────────────────────────────────
// Talks to /api/browser/agent/* and listens for WS `browser-agent-step`
// frames so the user sees the agent's actions stream in real time.
const _browserAgentState = {
  threadId: 'default',
  running: false,
  open: false,
  provider: null,
  providers: []
};
const _browserInspectState = {
  enabled: false,
  selected: null
};
async function _loadBrowserAgentStatus() {
  try {
    const r = await fetch('/api/browser/agent/status?threadId=' + encodeURIComponent(_browserAgentState.threadId));
    const data = await r.json();
    _browserAgentState.providers = data.providers || [];
    _browserAgentState.provider = data.defaultProvider || null;
    _populateBrowserAgentProviderSelect();
  } catch (_) {}
}
function _populateBrowserAgentProviderSelect() {
  const sel = document.getElementById('inappAgentProvider');
  if (!sel) return;
  const opts = _browserAgentState.providers;
  const configBtn = document.getElementById('inappAgentConfigureBtn');
  if (!opts.length) {
    sel.style.display = 'none';
    if (!configBtn) {
      const row = sel.parentNode;
      const btn = document.createElement('button');
      btn.id = 'inappAgentConfigureBtn';
      btn.className = 'inapp-agent-configure';
      btn.title = 'Open AI settings to add an API key';
      btn.innerHTML = '<i data-lucide="key" style="width:12px;height:12px;"></i> Configure API Keys';
      btn.onclick = function () {
        openSettings('ai');
        toggleBrowserAgentPanel();
      };
      row.insertBefore(btn, sel);
      if (typeof lucide !== 'undefined') lucide.createIcons({
        el: btn
      });
    }
    return;
  }
  if (configBtn) configBtn.remove();
  sel.style.removeProperty('display');
  sel.disabled = false;
  sel.innerHTML = opts.map(p => `<option value="${p.key}"${p.key === _browserAgentState.provider ? ' selected' : ''}>${p.label}</option>`).join('');
}
function _onBrowserAgentProviderChange() {
  const sel = document.getElementById('inappAgentProvider');
  if (sel && sel.value) _browserAgentState.provider = sel.value;
}
function toggleBrowserAgentPanel() {
  const panel = document.getElementById('inappAgentPanel');
  const chip = document.getElementById('inappAgentChip');
  if (!panel) return;
  _browserAgentState.open = !panel.classList.contains('open');
  panel.classList.toggle('open', _browserAgentState.open);
  if (chip) chip.classList.toggle('active', _browserAgentState.open);
  if (_browserAgentState.open) {
    _loadBrowserAgentStatus();
    setTimeout(() => {
      const i = document.getElementById('inappAgentInput');
      if (i) i.focus();
    }, 50);
  }
}
function _setBrowserAgentRunning(running) {
  _browserAgentState.running = !!running;
  const chip = document.getElementById('inappAgentChip');
  const state = document.getElementById('inappAgentState');
  const stopBtn = document.getElementById('inappAgentStopBtn');
  const send = document.getElementById('inappAgentSend');
  if (chip) chip.classList.toggle('running', running);
  if (state) {
    state.textContent = running ? 'running' : 'idle';
    state.className = 'inapp-agent-state' + (running ? ' running' : '');
  }
  if (stopBtn) stopBtn.style.display = running ? 'inline-block' : 'none';
  if (send) send.disabled = running;
}
function _appendBrowserActionReports(row, reports) {
  if (!row || !Array.isArray(reports) || !reports.length) return;
  const body = row.querySelector('.agent-msg-body');
  if (!body) return;
  const wrap = document.createElement('div');
  wrap.className = 'browser-action-report-group';
  reports.slice(-4).forEach(report => {
    const card = document.createElement('div');
    card.className = 'browser-action-report';
    const head = document.createElement('div');
    head.className = 'browser-action-report-head';
    const title = document.createElement('div');
    title.className = 'browser-action-report-title';
    title.textContent = report && report.title ? report.title : 'Browser action';
    head.appendChild(title);
    card.appendChild(head);
    const lines = Array.isArray(report && report.summaryLines) ? report.summaryLines.filter(Boolean) : [];
    if (lines.length) {
      const list = document.createElement('ul');
      list.className = 'browser-action-report-list';
      lines.forEach(line => {
        const li = document.createElement('li');
        li.textContent = line;
        list.appendChild(li);
      });
      card.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'browser-action-report-empty';
      empty.textContent = 'Relevant browser activity was captured for this action.';
      card.appendChild(empty);
    }
    const actions = document.createElement('div');
    actions.className = 'browser-action-report-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browser-action-report-expand';
    btn.textContent = 'Expand';
    btn.onclick = function () {
      openBrowserAgentDetailModal(report);
    };
    actions.appendChild(btn);
    card.appendChild(actions);
    wrap.appendChild(card);
  });
  body.appendChild(wrap);
}
function openBrowserAgentDetailModal(report) {
  const modal = document.getElementById('browserAgentDetailModal');
  const title = document.getElementById('browserAgentDetailTitle');
  const summary = document.getElementById('browserAgentDetailSummary');
  const pre = document.getElementById('browserAgentDetailPre');
  if (!modal || !title || !summary || !pre) return;
  title.textContent = report && report.title || 'Browser Action Details';
  summary.textContent = Array.isArray(report && report.summaryLines) ? report.summaryLines.join(' ') : '';
  pre.textContent = JSON.stringify(report && report.detail || report || {}, null, 2);
  modal.classList.add('open');
}
function closeBrowserAgentDetailModal() {
  const modal = document.getElementById('browserAgentDetailModal');
  if (modal) modal.classList.remove('open');
}
function _appendAgentLog(kind, text, extra) {
  const log = document.getElementById('inappAgentLog');
  if (!log) return null;
  const row = document.createElement('div');
  row.className = 'agent-msg ' + kind;
  if (kind === 'action') {
    const glyph = document.createElement('span');
    glyph.className = 'agent-action-glyph';
    glyph.textContent = '›';
    row.appendChild(glyph);
    row.appendChild(document.createTextNode(text || ''));
    if (extra && extra.fail) row.classList.add('fail');
  } else {
    const body = document.createElement('div');
    body.className = 'agent-msg-body';
    body.innerHTML = renderMarkdown(text || '');
    row.appendChild(body);
  }
  // First time: drop the hint.
  const hint = log.querySelector('.inapp-agent-hint');
  if (hint) hint.remove();
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}
function _appendBrowserAgentWaitingRow(message) {
  const log = document.getElementById('inappAgentLog');
  if (!log) return null;
  // Replace any prior waiting row so a second wait_for_user doesn't pile up.
  const prior = log.querySelector('.agent-msg.waiting');
  if (prior) prior.remove();
  const row = document.createElement('div');
  row.className = 'agent-msg waiting';
  row.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:10px 12px; border:1px solid var(--border, #444); border-radius:6px; background:rgba(255,180,0,0.08); margin:6px 0;';
  const body = document.createElement('div');
  body.className = 'agent-msg-body';
  body.style.cssText = 'font-size:13px; line-height:1.4;';
  body.textContent = message;
  row.appendChild(body);
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; align-items:center;';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Resume';
  btn.style.cssText = 'padding:4px 12px; border:1px solid var(--border, #555); background:var(--accent, #2a7); color:#fff; border-radius:4px; cursor:pointer; font-size:12px;';
  btn.onclick = async function () {
    btn.disabled = true;
    btn.textContent = 'Resuming...';
    try {
      await fetch('/api/browser/agent/resume', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          threadId: _browserAgentState.threadId
        })
      });
      row.remove();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Resume';
      _appendAgentLog('error', 'Failed to resume: ' + (e && e.message ? e.message : String(e)));
    }
  };
  actions.appendChild(btn);
  row.appendChild(actions);
  const startHint = log.querySelector('.inapp-agent-hint');
  if (startHint) startHint.remove();
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

// ── Automation tab activity indicator ──────────────────────────────────────
// Mirrors the orchestrator-tab pulse: a green pulse dot appears on the left
// of the Automation parent tab whenever automation is running (Stagehand or
// browser-use). Pings are debounced -- the dot stays for 8s after the last
// signal, then disappears.
const _automationActivity = {
  lastPing: 0,
  idleTimer: null
};
function _markAutomationActive() {
  _automationActivity.lastPing = Date.now();
  const btn = document.getElementById('automationTabBtn');
  if (btn && !btn.querySelector('.browser-pulse-dot')) {
    const dot = document.createElement('span');
    dot.className = 'browser-pulse-dot';
    btn.insertBefore(dot, btn.firstChild);
  }
  if (_automationActivity.idleTimer) clearTimeout(_automationActivity.idleTimer);
  _automationActivity.idleTimer = setTimeout(() => {
    if (Date.now() - _automationActivity.lastPing >= 8000) {
      const b = document.getElementById('automationTabBtn');
      const d = b && b.querySelector('.browser-pulse-dot');
      if (d) d.remove();
    }
  }, 8500);
}
// Backwards-compat alias for older call sites.
function _markBrowserTabActive() {
  _markAutomationActive();
}
function _focusAutomationBrowser() {
  try {
    if (typeof switchTab === 'function') switchTab('automation');
    if (typeof switchAutomationSubTab === 'function') switchAutomationSubTab('browser');
  } catch (_) {}
}

// ── Stagehand screencast viewer ────────────────────────────────────────────
// Renders the CDP screencast frames broadcast by the Stagehand plugin so the
// user sees Stagehand's session inside the same Browser tab they use for the
// in-app webview. Auto-shows on first frame, auto-hides after 8s of silence.
const _stagehandCast = {
  lastFrame: 0,
  idleTimer: null,
  img: null
};
function handleStagehandScreencast(msg) {
  if (!msg || !msg.data) return;
  _markAutomationActive();
  // First-frame fallback: if the dispatch broadcast was missed (or dropped
  // because the user was switching tabs), the first screencast frame still
  // pulls them onto the Browser tab so they don't miss the run.
  if (!_stagehandCast.lastFrame) _focusAutomationBrowser();
  const overlay = document.getElementById('stagehandScreencastOverlay');
  const canvas = document.getElementById('stagehandScreencastCanvas');
  const urlEl = document.getElementById('stagehandScreencastUrl');
  if (!overlay || !canvas) return;
  if (overlay.style.display === 'none') overlay.style.display = 'block';
  if (urlEl && msg.url) urlEl.textContent = msg.url;
  _stagehandCast.lastFrame = Date.now();
  if (_stagehandCast.idleTimer) clearTimeout(_stagehandCast.idleTimer);
  _stagehandCast.idleTimer = setTimeout(() => {
    if (Date.now() - _stagehandCast.lastFrame >= 8000) {
      // No frames for 8s: assume the agent is finished. Hide quietly.
      overlay.style.display = 'none';
    }
  }, 8500);

  // Use a fresh Image per frame so a slow decode never gets cancelled by the
  // next frame's src assignment, and so the canvas keeps showing the latest
  // fully-decoded frame even when frames arrive faster than the GPU draws.
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth || 1280;
    if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight || 720;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.onerror = () => {/* ignore malformed frame */};
  img.src = 'data:image/jpeg;base64,' + msg.data;
}
function closeStagehandScreencast() {
  const overlay = document.getElementById('stagehandScreencastOverlay');
  if (overlay) overlay.style.display = 'none';
  fetch('/api/plugins/stagehand/screencast/stop', {
    method: 'POST'
  }).catch(() => {});
}
function handleBrowserRouterDispatch(msg) {
  if (!msg) return;
  _markAutomationActive();
  const fallbacks = Array.isArray(msg.fallbacks) ? msg.fallbacks : [];
  const stagehandFallback = fallbacks.find(f => f && f.from === 'stagehand');
  // Start: switch to Automation -> Browser so the user watches the run live.
  if (!msg.phase || msg.phase === 'start') {
    _focusAutomationBrowser();
    if (msg.driver === 'stagehand') {
      const overlay = document.getElementById('stagehandScreencastOverlay');
      if (overlay && overlay.style.display === 'none') overlay.style.display = 'block';
    }
  }
  // End/error: bring the user back to the Terminal so they can see the
  // final result printed by whatever called the router. Hide the screencast
  // overlay too so it doesn't keep showing the last frame.
  if (msg.phase === 'end' || msg.phase === 'error') {
    try {
      if (typeof switchTab === 'function') switchTab('terminal');
    } catch (_) {}
    const overlay = document.getElementById('stagehandScreencastOverlay');
    if (overlay) overlay.style.display = 'none';
    // Stop the Chromium-side screencast so we're not paying for frames the
    // user can no longer see.
    fetch('/api/plugins/stagehand/screencast/stop', {
      method: 'POST'
    }).catch(() => {});
  }
  if (stagehandFallback && typeof notify === 'function') {
    notify('Stagehand unavailable', (stagehandFallback.reason || 'Stagehand failed') + '. Fell back to browser-use.', {
      icon: 'alert-triangle'
    });
  } else if (msg.phase === 'error' && msg.driver === 'stagehand' && typeof notify === 'function') {
    notify('Stagehand failed', msg.error || 'Browser automation failed before a fallback could run.', {
      icon: 'alert-circle'
    });
  }
}
function handleBrowserAgentStep(msg) {
  if (!msg) return;
  _markBrowserTabActive();
  if (msg.threadId !== _browserAgentState.threadId) return;
  switch (msg.kind) {
    case 'provider':
      {
        const state = document.getElementById('inappAgentState');
        if (state) {
          state.textContent = msg.label || msg.provider || 'running';
        }
        break;
      }
    case 'user':
      // Echoed back; we already rendered locally when sending.
      break;
    case 'thinking':
      // Replace the previous thinking row if present.
      _browserAgentState._thinkingRow && _browserAgentState._thinkingRow.remove();
      _browserAgentState._thinkingRow = _appendAgentLog('thinking', 'Thinking (step ' + (msg.iter || '?') + ')...');
      break;
    case 'message':
      _browserAgentState._thinkingRow && (_browserAgentState._thinkingRow.remove(), _browserAgentState._thinkingRow = null);
      _appendAgentLog('message', msg.text || '');
      break;
    case 'action':
      _browserAgentState._thinkingRow && (_browserAgentState._thinkingRow.remove(), _browserAgentState._thinkingRow = null);
      _appendAgentLog('action', msg.summary || msg.tool || 'action');
      break;
    case 'observation':
      if (msg.ok === false) _appendAgentLog('action', (msg.tool || 'tool') + ' failed: ' + (msg.error || ''), {
        fail: true
      });
      break;
    case 'waiting':
      _browserAgentState._thinkingRow && (_browserAgentState._thinkingRow.remove(), _browserAgentState._thinkingRow = null);
      _appendBrowserAgentWaitingRow(msg.message || 'User action required.');
      break;
    case 'done':
      _browserAgentState._thinkingRow && (_browserAgentState._thinkingRow.remove(), _browserAgentState._thinkingRow = null);
      {
        const row = _appendAgentLog('done', msg.summary || 'Done.');
        if (row && Array.isArray(msg.reports) && msg.reports.length) _appendBrowserActionReports(row, msg.reports);
      }
      _setBrowserAgentRunning(false);
      if (typeof toast === 'function') {
        const summary = String(msg.summary || 'Browser automation completed.').replace(/\s+/g, ' ').slice(0, 200);
        toast('Browser - ' + summary, 'success', {
          duration: 5000
        });
      }
      break;
    case 'stopped':
      _appendAgentLog('message', 'Stopped by user.');
      _setBrowserAgentRunning(false);
      break;
    case 'error':
      _appendAgentLog('error', msg.message || 'Error');
      _setBrowserAgentRunning(false);
      break;
  }
}
function _composeBrowserAgentTask(task) {
  const rawTask = String(task || '').trim();
  if (!rawTask) return '';
  if (!_browserInspectState.selected) return rawTask;
  return ['Use the current browser page to help the user. You have full control of this browser and can do anything a human user could do here - navigate, click, type, scroll, fill forms, inspect, modify the DOM, read any content on the page. Act directly; do not ask for permission on routine browser actions.', '', 'A page element is currently selected. Treat it as the target element unless the user explicitly overrides that target. If the request says "this", "it", "selected", "remove this", or is otherwise ambiguous, assume it refers to the selected element below.', '', 'Selected element:', '```json', JSON.stringify(_browserInspectState.selected, null, 2), '```', '', 'User request: ' + rawTask].join('\n');
}

// ── Pre-flight page map (analyze before acting) ──────────────────────────
// Cache keyed by URL so we don't re-scan on every message. Invalidated by
// navigation events elsewhere in the agent code.
const _pageMapCache = {
  url: '',
  map: null,
  ts: 0
};
const PAGE_MAP_SCRIPT = `(function(){
  function parseColor(str){
    if (!str) return null;
    var m = String(str).match(/rgba?\\((-?[0-9.]+)[,\\s]+(-?[0-9.]+)[,\\s]+(-?[0-9.]+)(?:[,/\\s]+([0-9.]+%?))?\\)/);
    if (!m) return null;
    var a = m[4] == null ? 1 : (String(m[4]).slice(-1) === '%' ? parseFloat(m[4])/100 : parseFloat(m[4]));
    if (a <= 0.02) return null;
    var r = Math.round(parseFloat(m[1])), g = Math.round(parseFloat(m[2])), b = Math.round(parseFloat(m[3]));
    function h(v){ var x = v.toString(16); return x.length<2 ? '0'+x : x; }
    return '#' + h(r) + h(g) + h(b);
  }
  function selectorOf(el){
    if (!el || el === document.body || el === document.documentElement) return el && el.tagName ? el.tagName.toLowerCase() : null;
    if (el.id) return '#' + el.id;
    var tag = el.tagName.toLowerCase();
    var cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return cls ? tag + '.' + cls : tag;
  }
  function trimText(s, n){ s = (s || '').replace(/\\s+/g,' ').trim(); return s.length > n ? s.slice(0, n) + '...' : s; }

  var url = location.href;
  var host = location.hostname;
  var title = document.title;
  var lang = document.documentElement.getAttribute('lang') || null;
  var viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };

  // Framework fingerprint (cheap heuristics).
  var fw = [];
  try {
    if (window.React || document.querySelector('[data-reactroot], #__next, [data-reactid]')) fw.push('React');
    if (document.querySelector('#__next, script[src*="_next/"]')) fw.push('Next.js');
    if (window.Vue || document.querySelector('[data-v-app], #__nuxt')) fw.push('Vue');
    if (document.querySelector('#__nuxt, script[src*="_nuxt/"]')) fw.push('Nuxt');
    if (document.querySelector('astro-island, [astro-island]')) fw.push('Astro');
    if (document.body && /wp-/.test(document.body.className || '') || document.querySelector('meta[name="generator"][content*="WordPress" i]')) fw.push('WordPress');
    if (document.querySelector('[class*="tw-"], script[src*="tailwind"]') || /tailwind/i.test(document.documentElement.className || '')) fw.push('Tailwind');
    if (document.querySelector('[class*="MuiBox"], [class*="MuiButton"]')) fw.push('MUI');
    if (document.querySelector('[class^="sc-"], [class*=" sc-"]')) fw.push('styled-components');
    if (document.querySelector('script[src*="bootstrap"], [class*="container-fluid"]')) fw.push('Bootstrap');
    if (document.querySelector('script[src*="shopify"], meta[name="shopify-digital-wallet"]')) fw.push('Shopify');
  } catch (_) {}

  // Which element paints the page background? Walk html / body / first-child
  // until we find a non-transparent bg. This is the "real target" for
  // "change the background color" requests.
  function firstPainted(root){
    var el = root, seen = 0;
    while (el && seen < 6) {
      try {
        var bg = parseColor(getComputedStyle(el).backgroundColor);
        if (bg) return { selector: selectorOf(el), hex: bg };
      } catch (_) {}
      el = el.children && el.children[0];
      seen++;
    }
    return null;
  }
  var htmlBg = null, bodyBg = null, firstBg = null;
  try { htmlBg = parseColor(getComputedStyle(document.documentElement).backgroundColor); } catch(_){}
  try { bodyBg = parseColor(getComputedStyle(document.body).backgroundColor); } catch(_){}
  try { firstBg = firstPainted(document.body); } catch(_){}
  var backgroundTarget = (bodyBg ? { selector: 'body', hex: bodyBg } : null) || firstBg || (htmlBg ? { selector: 'html', hex: htmlBg } : null);

  // Palette (body bg/text + headings + links + first buttons + theme meta)
  var byHex = {};
  function addColor(hex, role){
    if (!hex) return;
    hex = hex.toLowerCase();
    if (!byHex[hex]) byHex[hex] = { hex: hex, roles: [] };
    if (byHex[hex].roles.indexOf(role) < 0) byHex[hex].roles.push(role);
  }
  try {
    if (bodyBg) addColor(bodyBg, 'background');
    addColor(parseColor(getComputedStyle(document.body).color), 'text');
    Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 4).forEach(function(h){ addColor(parseColor(getComputedStyle(h).color), 'heading'); });
    Array.from(document.querySelectorAll('a')).slice(0, 4).forEach(function(a){ addColor(parseColor(getComputedStyle(a).color), 'link'); });
    Array.from(document.querySelectorAll('button, [role="button"], [class*="btn"]')).slice(0, 6).forEach(function(b){
      addColor(parseColor(getComputedStyle(b).backgroundColor), 'button-bg');
      addColor(parseColor(getComputedStyle(b).color), 'button-text');
    });
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc && tc.content) addColor(tc.content.toLowerCase(), 'theme');
  } catch (_) {}
  var palette = Object.values(byHex);

  // CSS custom properties on :root that look like colors.
  var cssVars = [];
  try {
    var cs = getComputedStyle(document.documentElement);
    for (var i = 0; i < Math.min(cs.length, 400); i++) {
      var n = cs[i];
      if (n && n.indexOf('--') === 0) {
        var v = (cs.getPropertyValue(n) || '').trim();
        if (/^(#[0-9a-f]{3,8}|rgba?\\(|hsla?\\()/i.test(v)) {
          if (cssVars.length < 20) cssVars.push({ name: n, value: v });
        }
      }
    }
  } catch (_) {}

  // Typography
  var typography = {};
  try {
    var b = getComputedStyle(document.body);
    typography.body = { family: b.fontFamily, size: b.fontSize, lineHeight: b.lineHeight };
    var h1 = document.querySelector('h1'); if (h1) { var c = getComputedStyle(h1); typography.h1 = { family: c.fontFamily, size: c.fontSize, weight: c.fontWeight }; }
  } catch (_) {}

  // Major regions: semantic landmarks + first-level children of body.
  var regions = [];
  try {
    var seen = new Set();
    function push(el, label){
      if (!el || seen.has(el)) return;
      seen.add(el);
      var cs = getComputedStyle(el);
      regions.push({
        label: label,
        selector: selectorOf(el),
        tag: el.tagName.toLowerCase(),
        bg: parseColor(cs.backgroundColor),
        color: parseColor(cs.color),
        text: trimText(el.innerText || '', 80),
        children: el.children ? el.children.length : 0,
      });
    }
    ['header','nav','main','[role="main"]','section.hero,.hero','footer','aside'].forEach(function(sel){
      var el = document.querySelector(sel); if (el) push(el, sel);
    });
    if (regions.length < 6 && document.body) {
      Array.from(document.body.children).slice(0, 8).forEach(function(c, idx){ push(c, 'body >#'+(idx+1)); });
    }
  } catch (_) {}

  // Interactive surface
  var surface = {};
  try {
    surface.buttons = document.querySelectorAll('button, [role="button"]').length;
    surface.links = document.querySelectorAll('a[href]').length;
    surface.inputs = document.querySelectorAll('input, textarea, select').length;
    surface.forms = document.querySelectorAll('form').length;
    surface.images = document.querySelectorAll('img').length;
    var h1 = document.querySelector('h1');
    surface.firstHeading = h1 ? trimText(h1.innerText, 80) : null;
    var ctaLabels = Array.from(document.querySelectorAll('button, a.btn, a[class*="cta"]')).slice(0, 5).map(function(el){ return trimText(el.innerText || el.getAttribute('aria-label') || '', 40); }).filter(Boolean);
    surface.ctaLabels = ctaLabels;
  } catch (_) {}

  return {
    url: url, host: host, title: title, lang: lang, viewport: viewport,
    frameworks: fw, backgroundTarget: backgroundTarget,
    palette: palette.slice(0, 12),
    cssVars: cssVars,
    typography: typography,
    regions: regions.slice(0, 10),
    surface: surface,
  };
})();`;
async function _runPageMap() {
  const view = typeof _ensureInappBrowser === 'function' ? _ensureInappBrowser() : null;
  if (!view || view.tagName.toLowerCase() !== 'webview') return null;
  let url = '';
  try {
    url = view.getURL ? view.getURL() : view.src || '';
  } catch (_) {}
  if (url && _pageMapCache.url === url && _pageMapCache.map && Date.now() - _pageMapCache.ts < 5 * 60 * 1000) {
    return _pageMapCache.map;
  }
  try {
    const map = await view.executeJavaScript(PAGE_MAP_SCRIPT, true);
    if (map) {
      _pageMapCache.url = url;
      _pageMapCache.map = map;
      _pageMapCache.ts = Date.now();
    }
    return map;
  } catch (_) {
    return null;
  }
}
function _summarizePageMapForPrompt(map) {
  if (!map) return '';
  const lines = [];
  lines.push('Pre-flight page map (refresh by calling inspect_dom / get_page_source for specifics):');
  lines.push('- URL: ' + (map.url || '?'));
  lines.push('- Title: ' + (map.title || '?'));
  if (map.frameworks && map.frameworks.length) lines.push('- Frameworks: ' + map.frameworks.join(', '));
  if (map.backgroundTarget) lines.push('- Background paint target: `' + map.backgroundTarget.selector + '` (computed ' + map.backgroundTarget.hex + '). Use this for "change the background" requests.');
  if (map.palette && map.palette.length) {
    lines.push('- Palette (hex -> roles):');
    map.palette.forEach(p => lines.push('  - ' + p.hex + ' -> ' + (p.roles || []).join(', ')));
  }
  if (map.cssVars && map.cssVars.length) {
    lines.push('- Color CSS variables on :root:');
    map.cssVars.forEach(v => lines.push('  - ' + v.name + ': ' + v.value));
  }
  if (map.typography) {
    if (map.typography.body) lines.push('- Body type: ' + map.typography.body.family + ' @ ' + map.typography.body.size + ' / line-height ' + map.typography.body.lineHeight);
    if (map.typography.h1) lines.push('- H1: ' + map.typography.h1.family + ' @ ' + map.typography.h1.size + ' weight ' + map.typography.h1.weight);
  }
  if (map.regions && map.regions.length) {
    lines.push('- Major regions:');
    map.regions.forEach(r => {
      const bits = [r.label, '`' + r.selector + '`'];
      if (r.bg) bits.push('bg ' + r.bg);
      if (r.color) bits.push('fg ' + r.color);
      if (r.text) bits.push('"' + r.text + '"');
      lines.push('  - ' + bits.join(' | '));
    });
  }
  if (map.surface) {
    const s = map.surface;
    lines.push('- Surface: ' + (s.buttons || 0) + ' buttons, ' + (s.links || 0) + ' links, ' + (s.forms || 0) + ' forms, ' + (s.inputs || 0) + ' inputs, ' + (s.images || 0) + ' images.');
    if (s.firstHeading) lines.push('- First H1: "' + s.firstHeading + '"');
    if (s.ctaLabels && s.ctaLabels.length) lines.push('- Visible CTAs: ' + s.ctaLabels.map(x => '"' + x + '"').join(', '));
  }
  lines.push('');
  lines.push('Use this map to avoid guessing selectors. If it looks stale, call get_page_source or inspect_dom to refresh.');
  return lines.join('\n');
}
async function _sendBrowserAgentTask(task, displayText, options) {
  if (!task) return;
  if (_browserAgentState.running) return;
  _appendAgentLog('user', displayText || task);
  _setBrowserAgentRunning(true);
  // Pre-flight: analyze the page before sending to the agent. Shows a live
  // "Analyzing..." row; replaced with a "Page map ready" summary once done.
  // On cache hit we skip the row entirely.
  let pageMap = null;
  let analyzeRow = null;
  try {
    const view = _ensureInappBrowser && _ensureInappBrowser();
    let curUrl = '';
    try {
      curUrl = view && view.getURL ? view.getURL() : view ? view.src || '' : '';
    } catch (_) {}
    const cached = curUrl && _pageMapCache.url === curUrl && _pageMapCache.map && Date.now() - _pageMapCache.ts < 5 * 60 * 1000;
    if (!cached) analyzeRow = _appendAgentLog('action', 'Analyzing page...');
    pageMap = await _runPageMap();
    if (analyzeRow) {
      // _appendAgentLog('action', ...) renders as [glyph][#text]. Replace the
      // trailing text node with the finished summary without touching glyph.
      const newLabel = pageMap ? 'Page map ready (' + (pageMap.regions ? pageMap.regions.length : 0) + ' regions, ' + (pageMap.palette || []).length + ' colors)' : 'Page analysis skipped';
      let replaced = false;
      for (let i = analyzeRow.childNodes.length - 1; i >= 0; i--) {
        const n = analyzeRow.childNodes[i];
        if (n && n.nodeType === 3) {
          n.nodeValue = newLabel;
          replaced = true;
          break;
        }
      }
      if (!replaced) analyzeRow.appendChild(document.createTextNode(newLabel));
    }
  } catch (_) {
    pageMap = null;
  }
  let composedTask = _composeBrowserAgentTask(task, options || {});
  if (pageMap) {
    const summary = _summarizePageMapForPrompt(pageMap);
    if (summary) composedTask = summary + '\n\n---\n\n' + composedTask;
  }
  try {
    const res = await fetch('/api/browser/agent/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        task: composedTask,
        threadId: _browserAgentState.threadId,
        provider: _browserAgentState.provider || undefined
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      _appendAgentLog('error', data.error || 'HTTP ' + res.status);
      _setBrowserAgentRunning(false);
    } else if (data.label) {
      const state = document.getElementById('inappAgentState');
      if (state) state.title = data.label + ' (' + (data.model || '') + ')';
    }
  } catch (e) {
    _appendAgentLog('error', e.message || String(e));
    _setBrowserAgentRunning(false);
  }
}
async function sendBrowserAgent() {
  const input = document.getElementById('inappAgentInput');
  if (!input) return;
  const task = (input.value || '').trim();
  if (!task) return;
  input.value = '';
  _autosizeAgentInput(input);
  await _sendBrowserAgentTask(task);
}
async function refineBrowserAgentRequest() {
  const input = document.getElementById('inappAgentInput');
  const btn = document.getElementById('inappAgentRefine');
  if (!input) return;
  const draft = (input.value || '').trim();
  if (!draft) {
    toast('Type something first.', 'info', {
      duration: 1500
    });
    return;
  }
  if (btn) {
    btn.classList.add('refining');
    btn.textContent = 'Refining...';
  }
  try {
    const res = await fetch('/api/browser/agent/refine', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        draft,
        selection: _browserInspectState.selected || null,
        provider: _browserAgentState.provider || undefined
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || 'Refine failed');
    const refined = (data.refined || '').trim();
    if (refined && refined !== draft) {
      input.value = refined;
      _autosizeAgentInput(input);
      input.focus();
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (_) {}
      toast('Refined.', 'success', {
        duration: 1400
      });
    } else {
      toast('No changes — looked good already.', 'info', {
        duration: 1800
      });
    }
  } catch (e) {
    toast('Refine failed: ' + (e && e.message ? e.message : String(e)), 'error');
  } finally {
    if (btn) {
      btn.classList.remove('refining');
      btn.textContent = 'Refine with AI';
    }
  }
}
async function stopBrowserAgent() {
  try {
    await fetch('/api/browser/agent/stop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        threadId: _browserAgentState.threadId
      })
    });
  } catch (_) {}
}
async function resetBrowserAgent() {
  try {
    await fetch('/api/browser/agent/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        threadId: _browserAgentState.threadId
      })
    });
  } catch (_) {}
  const log = document.getElementById('inappAgentLog');
  if (log) {
    log.innerHTML = '<div class="inapp-agent-hint">Chat cleared. What should I do next?</div>';
  }
  _setBrowserAgentRunning(false);
}

// Full tab reset: destroy the webview (drops DOM, JS state, page history),
// clear the URL field, and wipe the agent chat. The webview will be
// recreated fresh on the next inappBrowserGo.
async function resetBrowserTab() {
  try {
    await resetBrowserAgent();
  } catch (_) {}
  const frame = document.getElementById('inappBrowserFrame');
  if (frame) frame.innerHTML = '';
  const input = document.getElementById('inappBrowserUrl');
  if (input) input.value = '';
  try {
    _clearBrowserSelection && _clearBrowserSelection();
  } catch (_) {}
  try {
    _resetOverlayStateForNewPage && _resetOverlayStateForNewPage();
  } catch (_) {}
  if (typeof toast === 'function') toast('Browser tab reset.', 'info');
}

// ── Symphonee browser kit (utilities injected into the page) ─────────────
const _SYM_BROWSER_KIT = `(function(){
  if (window.__symKit) return 'already';
  var BRACKET = '__symKit';
  var HL_ID = '__symKitHighlights';
  var FOCUS_ID = '__symKitFocusStyle';
  var DARK_ID = '__symKitDarkStyle';
  var GRAY_ID = '__symKitGrayStyle';
  function q(sel){ try { return Array.from(document.querySelectorAll(sel)); } catch(_) { return []; } }
  function ensureLayer(id){
    var l = document.getElementById(id);
    if (l) return l;
    l = document.createElement('div'); l.id = id;
    l.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.documentElement.appendChild(l);
    return l;
  }
  function clearLayer(id){ var l = document.getElementById(id); if (l) l.remove(); }
  function box(el){ return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; }
  function overlay(rect, opts){
    opts = opts || {};
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;box-sizing:border-box;border:2px solid ' + (opts.color || '#f38ba8') + ';background:' + (opts.bg || 'rgba(243,139,168,0.15)') + ';border-radius:2px;pointer-events:none;';
    if (opts.label) {
      var lbl = document.createElement('div');
      lbl.textContent = opts.label;
      lbl.style.cssText = 'position:absolute;left:0;top:-18px;background:' + (opts.color || '#f38ba8') + ';color:#1b1b1b;font:600 10px system-ui,sans-serif;padding:1px 6px;border-radius:2px 2px 0 0;white-space:nowrap;';
      d.appendChild(lbl);
    }
    return d;
  }
  function highlightAll(selector){
    clearLayer(HL_ID);
    var layer = ensureLayer(HL_ID);
    var els = q(selector).slice(0, 100);
    els.forEach(function(el, i){
      var r = box(el); if (!r || !r.width) return;
      layer.appendChild(overlay(r, { color: '#94e2d5', bg: 'rgba(148,226,213,0.15)', label: i === 0 ? selector + ' (' + els.length + ')' : null }));
    });
    return { matched: els.length };
  }
  function clearHighlight(){ clearLayer(HL_ID); }
  function setVisibility(selector, hide){
    var el = q(selector)[0]; if (!el) return { ok: false };
    if (hide) { el.dataset.symHiddenPrev = el.style.visibility || ''; el.style.visibility = 'hidden'; }
    else { el.style.visibility = el.dataset.symHiddenPrev || ''; delete el.dataset.symHiddenPrev; }
    return { ok: true, nowHidden: !!hide };
  }
  function toggleVisibility(selector){
    var el = q(selector)[0]; if (!el) return { ok: false };
    var isHidden = 'symHiddenPrev' in el.dataset || getComputedStyle(el).visibility === 'hidden';
    return setVisibility(selector, !isHidden);
  }
  function unhideAll(){
    document.querySelectorAll('[data-sym-hidden-prev]').forEach(function(el){
      el.style.visibility = el.dataset.symHiddenPrev || '';
      delete el.dataset.symHiddenPrev;
    });
    return { ok: true };
  }
  function applyDarkMode(on){
    var existing = document.getElementById(DARK_ID);
    if (!on) { if (existing) existing.remove(); return { ok: true, on: false }; }
    if (existing) return { ok: true, on: true };
    var css = ''
      + 'html{filter:invert(1) hue-rotate(180deg) !important;background:#111 !important;}'
      + 'img,video,picture,iframe,canvas,[style*="background-image"]{filter:invert(1) hue-rotate(180deg) !important;}';
    var s = document.createElement('style'); s.id = DARK_ID; s.textContent = css;
    document.documentElement.appendChild(s);
    return { ok: true, on: true };
  }
  function applyGrayscale(on){
    var existing = document.getElementById(GRAY_ID);
    if (!on) { if (existing) existing.remove(); return { ok: true, on: false }; }
    if (existing) return { ok: true, on: true };
    var s = document.createElement('style'); s.id = GRAY_ID; s.textContent = 'html{filter:grayscale(100%) !important;}';
    document.documentElement.appendChild(s);
    return { ok: true, on: true };
  }
  function applyFocusMode(on){
    var existing = document.getElementById(FOCUS_ID);
    if (!on) {
      if (existing) existing.remove();
      document.querySelectorAll('[data-sym-focus-hidden]').forEach(function(el){ el.removeAttribute('data-sym-focus-hidden'); });
      return { ok: true, on: false };
    }
    if (existing) return { ok: true, on: true };
    // Hide obvious chrome via class-list rules (scoped by tag/role so we don't nuke the main content).
    var css = ''
      + 'nav,aside,header,footer,[role="banner"],[role="complementary"],[role="contentinfo"],[role="navigation"]{display:none !important;}'
      + '.sidebar,.side-bar,[class*="-sidebar"],[class*="_sidebar"]{display:none !important;}'
      + '[class*="cookie"],[class*="newsletter"],[class*="popup"],[class*="modal"],[class*="overlay"],[class*="lightbox"]{display:none !important;}'
      + 'body{overflow:auto !important;}';
    var s = document.createElement('style'); s.id = FOCUS_ID; s.textContent = css;
    document.documentElement.appendChild(s);
    // Heuristic pass: hide any element whose COMPUTED position is fixed/sticky AND that overlaps viewport edges
    // (typical cookie banners, chat widgets, sticky headers). Leaves in-flow content alone.
    try {
      var vw = window.innerWidth, vh = window.innerHeight;
      Array.prototype.slice.call(document.body.querySelectorAll('*')).forEach(function(el){
        try {
          var cs = getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
          var r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          var touchesEdge = r.top < 8 || r.left < 8 || (vw - r.right) < 8 || (vh - r.bottom) < 8;
          if (!touchesEdge) return;
          el.setAttribute('data-sym-focus-hidden', '1');
          el.style.setProperty('display', 'none', 'important');
        } catch (_) {}
      });
    } catch (_) {}
    return { ok: true, on: true };
  }
  function getBoxModel(selector){
    var el = q(selector)[0]; if (!el) return null;
    var cs = getComputedStyle(el);
    function n(k){ return parseFloat(cs.getPropertyValue(k)) || 0; }
    var r = el.getBoundingClientRect();
    return {
      margin: { top: n('margin-top'), right: n('margin-right'), bottom: n('margin-bottom'), left: n('margin-left') },
      border: { top: n('border-top-width'), right: n('border-right-width'), bottom: n('border-bottom-width'), left: n('border-left-width') },
      padding: { top: n('padding-top'), right: n('padding-right'), bottom: n('padding-bottom'), left: n('padding-left') },
      width: Math.round(r.width - n('padding-left') - n('padding-right') - n('border-left-width') - n('border-right-width')),
      height: Math.round(r.height - n('padding-top') - n('padding-bottom') - n('border-top-width') - n('border-bottom-width')),
      outerWidth: Math.round(r.width), outerHeight: Math.round(r.height),
    };
  }
  function esc(s){ try { return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1'); } catch(_) { return s; } }
  function altSelectors(selector){
    var el = q(selector)[0]; if (!el) return [];
    var out = [];
    function push(s, label){ if (!s) return; var n = q(s).length; if (!n) return; out.push({ selector: s, count: n, label: label }); }
    var tag = el.tagName.toLowerCase();
    if (el.id) push(tag + '#' + esc(el.id), 'id');
    var dataAttrs = [];
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && a.value) dataAttrs.push('[' + a.name + '="' + a.value.replace(/"/g, '\\\\"') + '"]');
    }
    if (dataAttrs.length) push(tag + dataAttrs[0], 'data-attr');
    if (el.getAttribute && el.getAttribute('aria-label')) push(tag + '[aria-label="' + el.getAttribute('aria-label').replace(/"/g, '\\\\"') + '"]', 'aria-label');
    if (el.getAttribute && el.getAttribute('role')) push(tag + '[role="' + el.getAttribute('role') + '"]', 'role');
    if (el.name) push(tag + '[name="' + el.name + '"]', 'name');
    var cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).filter(Boolean) : [];
    cls.slice(0, 3).forEach(function(c){ push(tag + '.' + esc(c), 'class'); });
    if (cls.length >= 2) push(tag + '.' + cls.slice(0,2).map(esc).join('.'), 'classes');
    push(tag, 'tag');
    // De-dupe by selector string.
    var seen = {};
    return out.filter(function(o){ if (seen[o.selector]) return false; seen[o.selector] = 1; return true; }).slice(0, 6);
  }
  // Forward a small set of UI shortcuts from the webview back to the host
  // renderer via console.info. Host listens for __SYMPHONEE_KEY__<json>.
  var FORWARD_KEYS = { i:1, h:1, d:1, g:1, f:1, t:1, k:1, e:1, '?':1, '/':1, 'Escape':1 };
  function inEditable(t){
    if (!t) return false;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    if (t.isContentEditable) return true;
    try { if (t.closest && t.closest('[data-sym-editing]')) return true; } catch(_){}
    return false;
  }
  function onKey(ev){
    var t = ev.target;
    var isCmd = (ev.ctrlKey || ev.metaKey) && !ev.altKey;
    var k = ev.key;
    // Esc always forwards (lets the host exit inline editor / close panels).
    if (k === 'Escape') {
      console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: 'Escape' }));
      return; // do not preventDefault - let the page also react if it wants
    }
    if (isCmd && (k === 'k' || k === 'K')) {
      console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: 'k', ctrl: true, shift: !!ev.shiftKey }));
      ev.preventDefault();
      return;
    }
    if (inEditable(t)) return;
    if (isCmd) return; // only Ctrl+K passes through
    if (!FORWARD_KEYS[k] && !(k.toLowerCase && FORWARD_KEYS[k.toLowerCase()])) return;
    console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: k, shift: !!ev.shiftKey, ctrl: !!ev.ctrlKey }));
    ev.preventDefault();
  }
  document.addEventListener('keydown', onKey, true);
  window[BRACKET] = {
    highlightAll: highlightAll, clearHighlight: clearHighlight,
    setVisibility: setVisibility, toggleVisibility: toggleVisibility, unhideAll: unhideAll,
    applyDarkMode: applyDarkMode, applyGrayscale: applyGrayscale, applyFocusMode: applyFocusMode,
    getBoxModel: getBoxModel, altSelectors: altSelectors,
    state: { dark: false, gray: false, focus: false },
    cleanupKeys: function(){ document.removeEventListener('keydown', onKey, true); },
  };
  return 'installed';
})();`;
async function _ensureSymKit() {
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') return null;
  try {
    await view.executeJavaScript(_SYM_BROWSER_KIT, true);
  } catch (_) {}
  return view;
}
// On navigation, injected styles are wiped but renderer state isn't. Reset
// the flags + their menu labels so they match reality on the new page.
function _resetOverlayStateForNewPage() {
  _inappToolsState.grayscale = false;
  _inappToolsState.focus = false;
  // Re-render the tools menu if it's currently showing, so toggle pills match reality.
  if (_inappToolsState.open && _inappToolsState.current === 'menu') _renderInappToolsMenu();
}
async function _symKitCall(method, ...args) {
  const view = await _ensureSymKit();
  if (!view) return null;
  const js = `(function(){ try { return window.__symKit && window.__symKit.${method} ? window.__symKit.${method}(${args.map(a => JSON.stringify(a)).join(',')}) : null; } catch (e) { return { error: e.message || String(e) }; } })();`;
  try {
    return await view.executeJavaScript(js, true);
  } catch (_) {
    return null;
  }
}

// ── In-browser Tools (sidebar menu + sub-views) ─────────────────────────
const _inappToolsState = {
  open: false,
  current: null,
  brand: null,
  audit: null,
  patches: {
    loaded: null,
    list: []
  },
  grayscale: false,
  focus: false
};

// Legacy no-ops so any stray callers (keyboard shortcuts, etc.) keep working.
function toggleInappToolsMenu(ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  toggleInappToolsPanelMenu();
}
function closeInappToolsMenu() {}
function _closeInappToolsMenu() {}

// Open (or close) the tools panel and show the top-level menu.
function toggleInappToolsPanelMenu() {
  if (_inappToolsState.open && _inappToolsState.current === 'menu') {
    closeInappToolsPanel();
    return;
  }
  _openInappToolsPanel();
  _inappToolsState.current = 'menu';
  _renderInappToolsMenu();
}

// Tool registry: items shown in the menu. Keep order stable.
const _INAPP_TOOLS_ITEMS = [{
  kind: 'select',
  icon: 'crosshair',
  title: 'Select element',
  sub: 'Select and ask AI about this element.',
  toggle: true
}, {
  kind: 'sep'
}, {
  kind: 'brand',
  icon: 'palette',
  title: 'Detect brand',
  sub: 'Extract colors, fonts, logo, and meta from the current page.'
}, {
  kind: 'inspect',
  icon: 'code-2',
  title: 'Inspect code',
  sub: 'Human-readable view of tag, attributes, and computed styles.'
}, {
  kind: 'reader',
  icon: 'book-open',
  title: 'Reader view',
  sub: 'Strip the page down to its main article.'
}, {
  kind: 'audit',
  icon: 'gauge',
  title: 'Site audit',
  sub: 'SEO checks, performance timing, accessibility hints.'
}, {
  kind: 'emulate',
  icon: 'smartphone',
  title: 'Emulate device',
  sub: 'Viewport presets, color-scheme, reduced-motion.'
}, {
  kind: 'issues',
  icon: 'alert-octagon',
  title: 'Browser issues',
  sub: 'Live problems Chrome reports (CSP, mixed content, cookies).'
}, {
  kind: 'sep'
}, {
  kind: 'grayscale',
  icon: 'contrast',
  title: 'Grayscale',
  sub: 'Strip color for design/accessibility review.',
  toggle: true
}, {
  kind: 'focus',
  icon: 'focus',
  title: 'Focus mode',
  sub: 'Hide navs, banners, sticky overlays.',
  toggle: true
}, {
  kind: 'sep'
}, {
  kind: 'patches',
  icon: 'history',
  title: 'Saved patches',
  sub: 'Re-apply saved DOM/style edits for this URL.'
}, {
  kind: 'shortcuts',
  icon: 'keyboard',
  title: 'Keyboard shortcuts',
  sub: 'i / h / ? / Esc'
}];
function _renderInappToolsMenu() {
  _setInappToolsTitle('Tools');
  const body = document.getElementById('inappToolsBody');
  if (!body) return;
  const esc = _escapeHtml;
  const isActive = kind => {
    if (kind === 'select') return !!(window._browserInspectState && _browserInspectState.enabled);
    if (kind === 'grayscale') return !!_inappToolsState.grayscale;
    if (kind === 'focus') return !!_inappToolsState.focus;
    return false;
  };
  const rows = _INAPP_TOOLS_ITEMS.map(it => {
    if (it.kind === 'sep') return '<div class="inapp-tools-sep"></div>';
    const active = it.toggle && isActive(it.kind) ? ' data-active="1"' : '';
    const badge = it.toggle && isActive(it.kind) ? '<span class="inapp-tools-pill">On</span>' : '';
    return '<button class="inapp-tools-item" type="button"' + active + ' data-tool-kind="' + esc(it.kind) + '">' + '<i data-lucide="' + esc(it.icon) + '"></i>' + '<div class="inapp-tools-item-copy">' + '<div class="inapp-tools-item-title">' + esc(it.title) + '</div>' + '<div class="inapp-tools-item-sub">' + esc(it.sub) + '</div>' + '</div>' + badge + '</button>';
  }).join('');
  body.innerHTML = '<div class="inapp-tools-menu-list">' + rows + '</div>';
  body.onclick = function (ev) {
    const item = ev.target && ev.target.closest && ev.target.closest('[data-tool-kind]');
    if (!item) return;
    ev.preventDefault();
    const kind = item.getAttribute('data-tool-kind');
    _runInappToolFromMenu(kind);
  };
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _runInappToolFromMenu(kind) {
  if (kind === 'select') {
    toggleInappInspectMode();
    _renderInappToolsMenu();
    return;
  }
  if (kind === 'grayscale') {
    toggleInappGrayscale().then(() => _renderInappToolsMenu());
    return;
  }
  if (kind === 'focus') {
    toggleInappFocusMode().then(() => _renderInappToolsMenu());
    return;
  }
  if (kind === 'shortcuts') {
    showInappShortcutsHelp();
    return;
  }
  openInappTool(kind);
}

// Back button for sub-views, rendered as the panel head's leading affordance.
function _setInappToolsHeadBack(label) {
  const head = document.querySelector('.inapp-tools-head');
  if (!head) return;
  const old = head.querySelector('.inapp-tools-back');
  if (old) old.remove();
  if (!label) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inapp-tools-back';
  btn.title = 'Back to tools';
  btn.setAttribute('aria-label', 'Back to tools');
  btn.innerHTML = '<i data-lucide="chevron-left"></i>';
  btn.onclick = () => {
    _inappToolsState.current = 'menu';
    _renderInappToolsMenu();
    _setInappToolsHeadBack('');
  };
  head.prepend(btn);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons({
      nodes: [btn]
    });
  } catch (_) {}
}

// Legacy shims so any stray callers continue to work.
function toggleInappMoreMenu(ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  toggleInappMorePanel();
}
function closeInappMoreMenu() {}

// "More" opens inside the same tools sidebar as a dedicated sub-view.
function toggleInappMorePanel() {
  if (_inappToolsState.open && _inappToolsState.current === 'more') {
    closeInappToolsPanel();
    return;
  }
  _openInappToolsPanel();
  _inappToolsState.current = 'more';
  _setInappToolsHeadBack('');
  _setInappToolsTitle('More');
  _renderInappMorePanel();
}
function _renderInappMorePanel() {
  const body = document.getElementById('inappToolsBody');
  if (!body) return;
  body.onclick = null;
  body.innerHTML = `
    <div class="inapp-tools-menu-list">
      <button class="inapp-tools-item" type="button" data-more-action="reset">
        <i data-lucide="refresh-ccw"></i>
        <div class="inapp-tools-item-copy">
          <div class="inapp-tools-item-title">Reset tab</div>
          <div class="inapp-tools-item-sub">Drop the webview, clear chat, start fresh.</div>
        </div>
      </button>
      <button class="inapp-tools-item" type="button" data-more-action="external">
        <i data-lucide="external-link"></i>
        <div class="inapp-tools-item-copy">
          <div class="inapp-tools-item-title">Open external</div>
          <div class="inapp-tools-item-sub">Open this URL in your system browser.</div>
        </div>
      </button>
      <div class="inapp-tools-sep"></div>
      <div style="display:flex;flex-direction:column;gap:6px;padding:4px 2px;">
        <div style="font:600 10px var(--font-ui);color:var(--subtext1);letter-spacing:0.5px;text-transform:uppercase;">Zoom</div>
        <div style="display:flex;gap:4px;align-items:center;">
          <button class="tab-bar-btn" type="button" data-more-action="zoom-out" title="Zoom out"><i data-lucide="minus" style="width:13px;height:13px;"></i></button>
          <button class="inapp-browser-zoom-value" type="button" id="inappBrowserZoomValue" data-more-action="zoom-reset" title="Reset zoom">100%</button>
          <button class="tab-bar-btn" type="button" data-more-action="zoom-in" title="Zoom in"><i data-lucide="plus" style="width:13px;height:13px;"></i></button>
        </div>
      </div>
    </div>
  `;
  body.onclick = function (ev) {
    const t = ev.target && ev.target.closest && ev.target.closest('[data-more-action]');
    if (!t) return;
    ev.preventDefault();
    const action = t.getAttribute('data-more-action');
    if (action === 'reset') {
      resetBrowserTab();
      closeInappToolsPanel();
      return;
    }
    if (action === 'external') {
      inappBrowserOpenExternal();
      return;
    }
    if (action === 'zoom-out') {
      inappBrowserZoomOut();
      return;
    }
    if (action === 'zoom-reset') {
      inappBrowserZoomReset();
      return;
    }
    if (action === 'zoom-in') {
      inappBrowserZoomIn();
      return;
    }
  };
  try {
    _syncInappBrowserZoomUi();
  } catch (_) {}
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _openInappToolsPanel() {
  const p = document.getElementById('inappToolsPanel');
  if (!p) return;
  p.classList.add('open');
  _inappToolsState.open = true;
}
function closeInappToolsPanel() {
  const p = document.getElementById('inappToolsPanel');
  if (p) p.classList.remove('open');
  const wasInspect = _inappToolsState.current === 'inspect';
  const wasEmulate = _inappToolsState.current === 'emulate';
  _inappToolsState.open = false;
  _inappToolsState.current = null;
  _setInappToolsHeadBack('');
  if (wasInspect && _browserInspectState.enabled) toggleInappInspectMode(false);
  // Auto-reset device emulation on close so users can't get stuck with a
  // glitched page after leaving the Emulate tool with overrides applied.
  if (wasEmulate && typeof _emulateState !== 'undefined' && (_emulateState.device !== 'off' || _emulateState.colorScheme || _emulateState.reducedMotion || _emulateState.contrast || _emulateState.network !== 'no-throttle' || _emulateState.cpuRate !== 1)) {
    try {
      _resetAllEmulation();
    } catch (_) {}
  }
}
function _setInappToolsTitle(text) {
  const t = document.getElementById('inappToolsTitle');
  if (t) t.textContent = text;
}
function _setInappToolsBodyHtml(html) {
  const body = document.getElementById('inappToolsBody');
  if (body) body.innerHTML = html;
}
function _setInappToolsBodyLoading(text) {
  _setInappToolsBodyHtml('<div class="inapp-tools-empty"><i data-lucide="loader"></i>' + (text || 'Working...') + '</div>');
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _setInappToolsBodyError(text) {
  _setInappToolsBodyHtml('<div class="inapp-tools-empty" style="color:var(--red);"><i data-lucide="alert-triangle"></i>' + _escapeHtml(text || 'Something went wrong.') + '</div>');
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}
async function openInappTool(kind) {
  _openInappToolsPanel();
  _inappToolsState.current = kind;
  // Show a back arrow in the header so users can return to the tools menu.
  _setInappToolsHeadBack('back');
  // Reset the menu click handler since sub-views install their own.
  const body = document.getElementById('inappToolsBody');
  if (body) body.onclick = null;
  switch (kind) {
    case 'brand':
      await _runInappBrandDetect();
      break;
    case 'inspect':
      _runInappCodeInspect();
      break;
    case 'reader':
      await _runInappReaderView();
      break;
    case 'audit':
      await _runInappSiteAudit();
      break;
    case 'emulate':
      await _runInappEmulatePanel();
      break;
    case 'issues':
      await _runInappIssuesPanel();
      break;
    case 'patches':
      await _runInappPatchesPanel();
      break;
    default:
      _setInappToolsBodyHtml('<div class="inapp-tools-empty">Unknown tool.</div>');
  }
}

// ── Brand detect ─────────────────────────────────────────────────────────
const _BRAND_EXTRACT_SCRIPT = `(function(){
  function parseColor(str){
    if (!str) return null;
    var m = String(str).match(/rgba?\\((-?[0-9.]+)[,\\s]+(-?[0-9.]+)[,\\s]+(-?[0-9.]+)(?:[,/\\s]+([0-9.]+%?))?\\)/);
    if (!m) return null;
    var a = m[4] == null ? 1 : (String(m[4]).slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (a <= 0.02) return null;
    var r = Math.round(Math.max(0, Math.min(255, parseFloat(m[1]))));
    var g = Math.round(Math.max(0, Math.min(255, parseFloat(m[2]))));
    var b = Math.round(Math.max(0, Math.min(255, parseFloat(m[3]))));
    function h(v){ var x = v.toString(16); return x.length < 2 ? '0' + x : x; }
    return { hex: ('#' + h(r) + h(g) + h(b)).toLowerCase(), a: a };
  }
  function getMeta(name){
    var el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
    return el ? el.getAttribute('content') : null;
  }
  var title = document.title;
  var url = location.href;
  var host = location.hostname;
  var themeColor = getMeta('theme-color');
  var ogImage = getMeta('og:image');
  var ogSiteName = getMeta('og:site_name');
  var description = getMeta('og:description') || getMeta('description');
  var faviconEl = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  var favicon = faviconEl ? faviconEl.href : (location.origin + '/favicon.ico');

  // Palette: {hex, roles: Set, count}. Roles tell the user what the color is
  // used for (background / text / link / button-bg / button-text / border / accent / css-var).
  var byHex = {};
  function add(hex, role){
    if (!hex) return;
    hex = String(hex).toLowerCase();
    if (!byHex[hex]) byHex[hex] = { hex: hex, roles: {}, count: 0 };
    byHex[hex].roles[role] = (byHex[hex].roles[role] || 0) + 1;
    byHex[hex].count++;
  }
  function sample(el, role, prop){
    if (!el) return;
    try {
      var c = parseColor(getComputedStyle(el).getPropertyValue(prop));
      if (c) add(c.hex, role);
    } catch (_) {}
  }
  function sampleBorder(el){
    if (!el) return;
    try {
      var cs = getComputedStyle(el);
      ['border-top-color','border-right-color','border-bottom-color','border-left-color'].forEach(function(p){
        var c = parseColor(cs.getPropertyValue(p));
        if (c) add(c.hex, 'border');
      });
    } catch (_) {}
  }

  // Body defaults
  var body = document.body;
  sample(body, 'background', 'background-color');
  sample(body, 'text', 'color');

  // CSS custom properties on :root / html / body that look like color hex / rgb
  var CSSVAR_COLOR_RE = /^(#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\\(|hsla?\\()/i;
  var cssVars = [];
  try {
    var scopes = [document.documentElement, document.body];
    scopes.forEach(function(scope){
      if (!scope) return;
      var cs = getComputedStyle(scope);
      for (var i = 0; i < cs.length; i++) {
        var name = cs[i];
        if (name && name.indexOf('--') === 0) {
          var raw = cs.getPropertyValue(name).trim();
          if (CSSVAR_COLOR_RE.test(raw)) {
            var c = parseColor(raw);
            if (!c && raw.charAt(0) === '#') {
              // Expand 3-digit hex to 6-digit.
              var h = raw.replace('#','');
              if (h.length === 3) h = h.split('').map(function(x){return x+x;}).join('');
              h = h.slice(0, 6);
              c = /^[0-9a-f]{6}$/i.test(h) ? { hex: ('#' + h).toLowerCase(), a: 1 } : null;
            }
            if (c) {
              add(c.hex, 'css-var');
              if (cssVars.length < 24) cssVars.push({ name: name, hex: c.hex });
            }
          }
        }
      }
    });
  } catch (_) {}

  // Headings + links
  Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 6).forEach(function(h){ sample(h, 'heading', 'color'); });
  Array.from(document.querySelectorAll('a')).slice(0, 8).forEach(function(a){ sample(a, 'link', 'color'); });

  // Buttons: distinguish background from text explicitly.
  Array.from(document.querySelectorAll('button, [role="button"], [class*="btn"], .button, input[type="submit"], input[type="button"]')).slice(0, 10).forEach(function(b){
    sample(b, 'button-bg', 'background-color');
    sample(b, 'button-text', 'color');
    sampleBorder(b);
  });

  // Form fields
  var firstInput = document.querySelector('input[type="text"], input[type="email"], input[type="search"], textarea');
  if (firstInput) { sample(firstInput, 'input-bg', 'background-color'); sample(firstInput, 'input-text', 'color'); sampleBorder(firstInput); }

  // Theme color meta
  if (themeColor) {
    var tc = parseColor(themeColor) || (themeColor.charAt(0) === '#' ? { hex: themeColor.toLowerCase() } : null);
    if (tc) add(tc.hex, 'theme');
  }

  // Build palette. Each entry carries a primary label (most common role) + all roles.
  var ROLE_PRIORITY = ['theme','background','text','button-bg','button-text','link','heading','input-bg','input-text','border','css-var'];
  var palette = Object.keys(byHex).map(function(hex){
    var e = byHex[hex];
    var roles = Object.keys(e.roles);
    var primary = roles.slice().sort(function(a, b){
      var pa = ROLE_PRIORITY.indexOf(a); if (pa < 0) pa = 99;
      var pb = ROLE_PRIORITY.indexOf(b); if (pb < 0) pb = 99;
      return pa - pb;
    })[0] || 'color';
    return { hex: hex, role: primary, roles: roles, count: e.count };
  }).sort(function(a, b){
    var pa = ROLE_PRIORITY.indexOf(a.role); if (pa < 0) pa = 99;
    var pb = ROLE_PRIORITY.indexOf(b.role); if (pb < 0) pb = 99;
    if (pa !== pb) return pa - pb;
    return b.count - a.count;
  }).slice(0, 24);

  // Fonts
  var fonts = [];
  function addFont(family, role, size){
    family = (family || '').trim(); if (!family) return;
    var existing = fonts.find(function(f){return f.family === family;});
    if (existing){ if (existing.roles.indexOf(role) < 0) existing.roles.push(role); return; }
    fonts.push({ family: family, roles: [role], size: size });
  }
  if (body){ addFont(getComputedStyle(body).fontFamily, 'body', getComputedStyle(body).fontSize); }
  var h1 = document.querySelector('h1'); if (h1){ addFont(getComputedStyle(h1).fontFamily, 'heading', getComputedStyle(h1).fontSize); }
  var h2 = document.querySelector('h2'); if (h2){ addFont(getComputedStyle(h2).fontFamily, 'heading', getComputedStyle(h2).fontSize); }
  var btn = document.querySelector('button'); if (btn){ addFont(getComputedStyle(btn).fontFamily, 'ui', getComputedStyle(btn).fontSize); }

  return { title: title, url: url, host: host, themeColor: themeColor, ogImage: ogImage, ogSiteName: ogSiteName, description: description, favicon: favicon, palette: palette, cssVars: cssVars, fonts: fonts.slice(0, 4) };
})();`;
async function _runInappBrandDetect() {
  _setInappToolsTitle('Brand');
  _setInappToolsBodyLoading('Analyzing page...');
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') {
    _setInappToolsBodyError('Browser not ready.');
    return;
  }
  let data;
  try {
    data = await view.executeJavaScript(_BRAND_EXTRACT_SCRIPT, true);
  } catch (e) {
    _setInappToolsBodyError('Extraction failed: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  if (!data) {
    _setInappToolsBodyError('No data returned.');
    return;
  }
  _inappToolsState.brand = data;
  _renderInappBrandPanel(data);
}
function _renderInappBrandPanel(data) {
  const brandName = data.ogSiteName || data.title || data.host;
  const logoSrc = data.ogImage || data.favicon;
  const roleLabel = r => ({
    'theme': 'Theme',
    'background': 'Background',
    'text': 'Text',
    'link': 'Link',
    'heading': 'Heading',
    'button-bg': 'Button bg',
    'button-text': 'Button text',
    'border': 'Border',
    'input-bg': 'Input bg',
    'input-text': 'Input text',
    'css-var': 'CSS variable',
    'color': 'Color'
  })[r] || r;
  const palette = (data.palette || []).map(p => {
    const extraRoles = (p.roles || []).filter(r => r !== p.role);
    const subtitle = extraRoles.length ? extraRoles.map(roleLabel).join(', ') : '';
    return `
    <div class="brand-swatch" onclick="_copyText('${_escapeHtml(p.hex)}')" title="${_escapeHtml(p.hex)} — ${_escapeHtml(roleLabel(p.role))}${subtitle ? ' (also: ' + _escapeHtml(subtitle) + ')' : ''}">
      <div class="brand-swatch-chip" style="background:${_escapeHtml(p.hex)}"></div>
      <div class="brand-swatch-hex">${_escapeHtml(p.hex)}</div>
      <div class="brand-swatch-role">${_escapeHtml(roleLabel(p.role))}</div>
      ${subtitle ? `<div class="brand-swatch-sub" style="font:10px var(--font-ui);color:var(--subtext0);text-align:center;margin-top:1px;">${_escapeHtml(subtitle)}</div>` : ''}
    </div>
  `;
  }).join('');
  const cssVars = (data.cssVars || []).map(v => `
    <div class="brand-meta-row" onclick="_copyText('${_escapeHtml(v.name)}')" style="cursor:pointer;" title="Click to copy ${_escapeHtml(v.name)}">
      <span class="k" style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${_escapeHtml(v.hex)};border:1px solid rgba(0,0,0,0.15);"></span><code>${_escapeHtml(v.name)}</code></span>
      <span class="v" style="font:500 11px var(--font-mono);">${_escapeHtml(v.hex)}</span>
    </div>
  `).join('');
  const fonts = (data.fonts || []).map(f => `
    <div class="brand-font" style="font-family:${_escapeHtml(f.family)};">
      <div class="brand-font-role">${_escapeHtml(f.roles.join(' + '))}</div>
      <div class="brand-font-family">The quick brown fox</div>
      <div class="brand-font-meta">${_escapeHtml(f.family)}${f.size ? ' — ' + _escapeHtml(f.size) : ''}</div>
    </div>
  `).join('');
  const meta = [data.description ? {
    k: 'Description',
    v: data.description
  } : null, data.themeColor ? {
    k: 'Theme color',
    v: data.themeColor
  } : null, {
    k: 'Host',
    v: data.host
  }, {
    k: 'URL',
    v: data.url
  }].filter(Boolean).map(r => `<div class="brand-meta-row"><span class="k">${_escapeHtml(r.k)}</span><span class="v">${_escapeHtml(r.v)}</span></div>`).join('');
  const html = `
    <div class="brand-header">
      <div class="brand-header-logo">${logoSrc ? '<img src="' + _escapeHtml(logoSrc) + '" alt="" onerror="this.remove()"/>' : ''}</div>
      <div style="min-width:0;flex:1;">
        <div class="brand-header-name">${_escapeHtml(brandName)}</div>
        <div class="brand-header-url">${_escapeHtml(data.host)}</div>
      </div>
    </div>
    ${palette ? '<div class="brand-section-title">Palette</div><div class="brand-palette">' + palette + '</div>' : ''}
    ${cssVars ? '<div class="brand-section-title">CSS variables</div><div style="display:flex;flex-direction:column;gap:4px;">' + cssVars + '</div>' : ''}
    ${fonts ? '<div class="brand-section-title">Typography</div><div style="display:flex;flex-direction:column;gap:8px;">' + fonts + '</div>' : ''}
    ${meta ? '<div class="brand-section-title">Meta</div><div style="display:flex;flex-direction:column;gap:4px;">' + meta + '</div>' : ''}
    <div class="inapp-tools-actions" style="margin:8px -12px -12px;">
      <button class="tab-bar-btn" type="button" onclick="_saveBrandToNote()"><i data-lucide="save" style="width:13px;height:13px;"></i> Save to note</button>
      <button class="tab-bar-btn" type="button" onclick="_runInappBrandDetect()"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> Refresh</button>
      <button class="tab-bar-btn" type="button" onclick="_refineBrandWithAi()"><i data-lucide="sparkles" style="width:13px;height:13px;"></i> Ask AI to refine</button>
    </div>
  `;
  _setInappToolsBodyHtml(html);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _copyText(text) {
  try {
    navigator.clipboard.writeText(text);
    toast('Copied ' + text, 'success', {
      duration: 1400
    });
  } catch (_) {}
}
async function _saveBrandToNote() {
  const data = _inappToolsState.brand;
  if (!data) return;
  const brandName = data.ogSiteName || data.title || data.host;
  const palette = (data.palette || []).map(p => `- \`${p.hex}\` — ${p.role}`).join('\n');
  const fonts = (data.fonts || []).map(f => `- **${f.roles.join(' + ')}:** ${f.family}${f.size ? ' (' + f.size + ')' : ''}`).join('\n');
  const md = [`# ${brandName}`, '', data.description ? `> ${data.description}` : null, '', `- **URL:** ${data.url}`, data.themeColor ? `- **Theme color:** \`${data.themeColor}\`` : null, data.ogImage ? `- **Logo:** ${data.ogImage}` : null, data.favicon ? `- **Favicon:** ${data.favicon}` : null, '', '## Palette', palette || '_None detected._', '', '## Typography', fonts || '_None detected._', '', `_Captured ${new Date().toISOString()}_`].filter(l => l !== null).join('\n');
  const safeName = 'Brand — ' + (brandName || data.host).replace(/[^\w\s-]/g, '').slice(0, 80);
  try {
    await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: safeName
      })
    });
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: safeName,
        content: md
      })
    });
    toast('Saved to note: ' + safeName, 'success');
  } catch (e) {
    toast('Save failed: ' + (e && e.message ? e.message : String(e)), 'error');
  }
}
function _refineBrandWithAi() {
  const data = _inappToolsState.brand;
  if (!data) return;
  _ensureBrowserAgentPanelOpen();
  const input = _getBrowserAgentInput();
  if (!input) return;
  const lines = ["Refine and enrich this brand snapshot I extracted from the current page. Identify the actual brand name if different from what's here, dedupe near-duplicate colors, label primary / secondary / accent roles, and suggest a concise brand description. Respond with a clean Markdown brief.", '', '```json', JSON.stringify(data, null, 2), '```'];
  input.value = lines.join('\n');
  _autosizeAgentInput(input);
  input.focus();
}

// ── Code inspect ─────────────────────────────────────────────────────────
state._inspectActiveSelector = '';
function _runInappCodeInspect() {
  _setInappToolsTitle('Inspect code');
  _ensureSymKit();
  if (!_browserInspectState.enabled) {
    toggleInappInspectMode(true);
  } else {
    const view = _ensureInappBrowser();
    if (view) _applyInappInspectMode(view);
  }
  _renderInappCodeInspect();
}
function _renderInappCodeInspect() {
  const sel = _browserInspectState.selected;
  if (!sel) {
    state._inspectActiveSelector = '';
    _setInappToolsBodyHtml('<div class="code-inspect-empty"><i data-lucide="mouse-pointer-click" style="width:24px;height:24px;display:block;margin:0 auto 10px;color:var(--subtext1);"></i>Inspect mode is on. Click any element in the page to inspect its code.</div>');
    try {
      if (window.lucide && lucide.createIcons) lucide.createIcons();
    } catch (_) {}
    return;
  }
  state._inspectActiveSelector = sel.selector || '';
  const attrs = sel.attributes || {};
  const attrRows = Object.keys(attrs).length ? Object.entries(attrs).map(([k, v]) => `<div class="k">${_escapeHtml(k)}</div><div class="v">${_escapeHtml(v)}</div>`).join('') : '<div class="k" style="grid-column:1/-1;color:var(--subtext0);">No attributes</div>';
  _setInappToolsBodyHtml(`
    <div class="code-inspect-head">
      <div style="display:flex;gap:6px;align-items:center;">
        <div class="code-inspect-tag" style="flex:1;">&lt;${_escapeHtml(sel.tagName || 'element')}&gt;</div>
        <button class="tab-bar-btn" type="button" id="inspectEditBtn" title="Edit text inline (E to toggle, Esc to save)" onclick="_inspectToggleEdit()"><i data-lucide="edit-3" style="width:13px;height:13px;"></i></button>
        <button class="tab-bar-btn" type="button" id="inspectHideBtn" title="Hide / show element (H)" data-hidden="false" onclick="_inspectHideSelected()"><i data-lucide="eye" style="width:13px;height:13px;"></i></button>
        <button class="tab-bar-btn" type="button" title="Remove element" onclick="_inspectRemoveSelected()"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>
        <button class="tab-bar-btn" type="button" title="Scroll into view" onclick="_inspectScrollSelected()"><i data-lucide="crosshair" style="width:13px;height:13px;"></i></button>
      </div>
      ${sel.text ? '<div class="code-inspect-text" style="margin-top:6px;">' + _escapeHtml(_shortenBrowserText(sel.text, 200)) + '</div>' : ''}
    </div>
    <div id="inappInspectAltSelectors"></div>
    <div id="inappInspectBoxModel"></div>
    <div id="inappInspectQuickEdit"></div>
    <div class="code-inspect-group">
      <div class="code-inspect-group-title">Attributes</div>
      <div class="code-inspect-kv">${attrRows}</div>
    </div>
    <div id="inappCodeInspectStyles"><div class="inapp-tools-empty"><i data-lucide="loader" style="width:20px;height:20px;"></i>Loading computed styles...</div></div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
  _loadCodeInspectAll(sel).catch(() => {});
}
async function _loadCodeInspectAll(sel) {
  const selector = state._inspectActiveSelector || sel.selector || '';
  if (!selector) return;
  await _ensureSymKit();
  _renderInspectAltSelectors(selector).catch(() => {});
  _renderInspectBoxModel(selector).catch(() => {});
  await _loadCodeInspectStyles(sel, selector);
}
async function _renderInspectAltSelectors(selector) {
  const target = document.getElementById('inappInspectAltSelectors');
  if (!target) return;
  const alts = await _symKitCall('altSelectors', selector);
  if (!Array.isArray(alts) || !alts.length) {
    target.innerHTML = '';
    return;
  }
  target.innerHTML = `
    <div class="code-inspect-group">
      <div class="code-inspect-group-title">Selectors</div>
      <div onmouseleave="_symKitCall('clearHighlight')">
        ${alts.map(a => {
    const s = JSON.stringify(a.selector).replace(/"/g, '&quot;');
    return `<div class="alt-selector-row ${a.selector === state._inspectActiveSelector ? 'active' : ''}" onmouseenter="_symKitCall('highlightAll', ${s})" onclick="_pickInspectSelector(${s})"><span class="sel">${_escapeHtml(a.selector)}</span><span class="count">${a.count}</span><span class="label">${_escapeHtml(a.label)}</span></div>`;
  }).join('')}
      </div>
    </div>
  `;
}
function _pickInspectSelector(selector) {
  state._inspectActiveSelector = selector;
  _renderInspectAltSelectors(selector).catch(() => {});
  _renderInspectBoxModel(selector).catch(() => {});
  const sel = _browserInspectState.selected || {};
  _loadCodeInspectStyles(sel, selector).catch(() => {});
}
async function _renderInspectBoxModel(selector) {
  const target = document.getElementById('inappInspectBoxModel');
  if (!target) return;
  const bm = await _symKitCall('getBoxModel', selector);
  if (!bm) {
    target.innerHTML = '';
    return;
  }
  const r = n => n || 0;
  target.innerHTML = `
    <div class="code-inspect-group">
      <div class="code-inspect-group-title">Box model</div>
      <div class="box-model">
        <div class="box-model-margin">
          <span class="box-model-label">margin</span>
          <span class="box-model-edge top">${r(bm.margin.top)}</span>
          <span class="box-model-edge bottom">${r(bm.margin.bottom)}</span>
          <span class="box-model-edge left">${r(bm.margin.left)}</span>
          <span class="box-model-edge right">${r(bm.margin.right)}</span>
          <div class="box-model-border">
            <span class="box-model-label">border</span>
            <span class="box-model-edge top">${r(bm.border.top)}</span>
            <span class="box-model-edge bottom">${r(bm.border.bottom)}</span>
            <span class="box-model-edge left">${r(bm.border.left)}</span>
            <span class="box-model-edge right">${r(bm.border.right)}</span>
            <div class="box-model-padding">
              <span class="box-model-label">padding</span>
              <span class="box-model-edge top">${r(bm.padding.top)}</span>
              <span class="box-model-edge bottom">${r(bm.padding.bottom)}</span>
              <span class="box-model-edge left">${r(bm.padding.left)}</span>
              <span class="box-model-edge right">${r(bm.padding.right)}</span>
              <div class="box-model-content">${bm.width} × ${bm.height}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
function _renderInspectQuickEdit(selector, styles) {
  const target = document.getElementById('inappInspectQuickEdit');
  if (!target) return;
  const esc = v => _escapeHtml(v || '');
  const S = JSON.stringify(selector).replace(/"/g, '&quot;');
  const color = (styles['color'] || '').trim();
  const bg = (styles['background-color'] || '').trim();
  const colorHex = _rgbToHex(color);
  const bgHex = _rgbToHex(bg);
  target.innerHTML = `
    <div class="code-inspect-group">
      <div class="code-inspect-group-title">Quick edit</div>
      <div class="quick-edit-grid">
        <label>Color</label>
        <div class="color-row">
          <div class="color-chip" style="background:${esc(color) || 'transparent'}" onclick="_openColorEditorAtChip(this, ${S}, 'color', ${JSON.stringify(colorHex || '#000000').replace(/"/g, '&quot;')})" title="Pick"></div>
          <input type="text" value="${esc(color)}" onchange="_applyInspectStyle(${S}, 'color', this.value)" placeholder="e.g. #1a1a1a">
        </div>
        <label>Background</label>
        <div class="color-row">
          <div class="color-chip" style="background:${esc(bg) || 'transparent'}" onclick="_openColorEditorAtChip(this, ${S}, 'background-color', ${JSON.stringify(bgHex || '#ffffff').replace(/"/g, '&quot;')})" title="Pick"></div>
          <input type="text" value="${esc(bg)}" onchange="_applyInspectStyle(${S}, 'background-color', this.value)" placeholder="e.g. #fafafa">
        </div>
        <label>Font size</label>
        <input type="text" value="${esc(styles['font-size'])}" onchange="_applyInspectStyle(${S}, 'font-size', this.value)" placeholder="e.g. 16px">
        <label>Font weight</label>
        <select onchange="_applyInspectStyle(${S}, 'font-weight', this.value)">${['100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold'].map(w => `<option value="${w}" ${String(styles['font-weight']).trim() === w ? 'selected' : ''}>${w}</option>`).join('')}</select>
        <label>Padding</label>
        <input type="text" value="${esc(styles['padding'])}" onchange="_applyInspectStyle(${S}, 'padding', this.value)" placeholder="e.g. 12px 20px">
        <label>Margin</label>
        <input type="text" value="${esc(styles['margin'])}" onchange="_applyInspectStyle(${S}, 'margin', this.value)" placeholder="e.g. 0 auto">
        <label>Display</label>
        <select onchange="_applyInspectStyle(${S}, 'display', this.value)">${['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'contents'].map(d => `<option value="${d}" ${String(styles['display']).trim() === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
      </div>
    </div>
  `;
}
async function _loadCodeInspectStyles(sel, forcedSelector) {
  const view = _getInappWebview();
  if (!view || view.tagName.toLowerCase() !== 'webview') return;
  const selector = forcedSelector || sel.selector || '';
  if (!selector) return;
  const script = `(function(){
    try {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var cs = getComputedStyle(el);
      var keys = ['color','background-color','background-image','font-family','font-size','font-weight','line-height','letter-spacing','text-transform','text-align','border','border-radius','box-shadow','opacity','padding','margin','width','height','display','position','z-index','cursor','transition','transform'];
      var out = {}; keys.forEach(function(k){ try { out[k] = cs.getPropertyValue(k); } catch(_){} });
      return out;
    } catch (e) { return null; }
  })();`;
  let styles = null;
  try {
    styles = await view.executeJavaScript(script, true);
  } catch (_) {}
  _renderInspectQuickEdit(selector, styles || {});
  const target = document.getElementById('inappCodeInspectStyles');
  if (!target) return;
  if (!styles) {
    target.innerHTML = '<div class="inapp-tools-empty" style="color:var(--subtext0);">Could not read computed styles.</div>';
    return;
  }
  const groups = {
    'Typography': ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align'],
    'Colors': ['color', 'background-color', 'background-image', 'border', 'border-radius', 'box-shadow', 'opacity'],
    'Layout': ['display', 'position', 'z-index', 'width', 'height', 'padding', 'margin', 'cursor', 'transform'],
    'Motion': ['transition']
  };
  function isColor(key, val) {
    if (!val) return false;
    if (key === 'color' || key === 'background-color') return /^rgb/.test(val) && !/rgba\([^,]+,[^,]+,[^,]+,\s*0\)/.test(val);
    return false;
  }
  function wrapNumbers(val) {
    return String(val).replace(/(-?\d+(?:\.\d+)?)(px|em|rem|%)/g, '<span class="scrub" data-unit="$2" data-val="$1" onmousedown="_scrubStart(event, this)" title="Alt+drag to scrub">$1$2</span>');
  }
  const blocks = Object.entries(groups).map(([groupName, keys]) => {
    const rows = keys.filter(k => styles[k] && styles[k].trim()).map(k => {
      const v = styles[k];
      const scrubbable = !isColor(k, v) && /\d+(px|em|rem|%)/.test(v);
      let displayV = _escapeHtml(v);
      if (scrubbable) displayV = wrapNumbers(displayV);
      let swatch = '';
      if (isColor(k, v)) {
        const hex = _rgbToHex(v) || v;
        const S = JSON.stringify(state._inspectActiveSelector).replace(/"/g, '&quot;');
        const K = JSON.stringify(k).replace(/"/g, '&quot;');
        const H = JSON.stringify(hex).replace(/"/g, '&quot;');
        swatch = `<span class="chip" style="background:${_escapeHtml(v)}" onclick="_openColorEditorAtChip(this, ${S}, ${K}, ${H})"></span>`;
      }
      const propCell = `<div class="k prop" data-prop="${_escapeHtml(k)}" onmouseenter="_propdocShow(event, this)" onmouseleave="_propdocHide()">${_escapeHtml(k)}</div>`;
      const K = JSON.stringify(k).replace(/"/g, '&quot;');
      const V = JSON.stringify(v).replace(/"/g, '&quot;');
      const valCell = `<div class="v${swatch ? ' swatch' : ''}" onmouseenter="_quickviewShow(event, ${K}, ${V})" onmouseleave="_quickviewHide()" data-prop="${_escapeHtml(k)}">${swatch}${displayV}</div>`;
      return propCell + valCell;
    }).join('');
    if (!rows) return '';
    return `<div class="code-inspect-group"><div class="code-inspect-group-title">${_escapeHtml(groupName)}</div><div class="code-inspect-kv">${rows}</div></div>`;
  }).join('');
  target.innerHTML = blocks || '<div class="inapp-tools-empty">No styles.</div>';
}
async function _inspectHideSelected() {
  const sel = state._inspectActiveSelector;
  if (!sel) return;
  await _ensureSymKit();
  const res = await _symKitCall('toggleVisibility', sel);
  const nowHidden = !!(res && res.nowHidden);
  if (nowHidden) _recordPatch({
    op: 'hide',
    selector: sel
  });
  // Swap the icon between "eye-off" (element is currently hidden, click to
  // show) and "eye" (element is visible, click to hide). Lucide replaces
  // the <i> tag with an <svg> on first render, so toggling data-lucide on
  // the old <i> is a no-op — we have to re-inject a fresh <i> and rerun
  // createIcons to get a new SVG each time.
  const btn = document.getElementById('inspectHideBtn');
  if (btn) {
    btn.dataset.hidden = nowHidden ? 'true' : 'false';
    btn.title = nowHidden ? 'Show element (H)' : 'Hide element (H)';
    const iconName = nowHidden ? 'eye-off' : 'eye';
    btn.innerHTML = '<i data-lucide="' + iconName + '" style="width:13px;height:13px;"></i>';
    try {
      lucide.createIcons({
        nodes: [btn]
      });
    } catch (_) {}
  }
  toast(nowHidden ? 'Hidden (click again to show)' : 'Shown', 'success', {
    duration: 1200
  });
}
async function _inspectRemoveSelected() {
  const sel = state._inspectActiveSelector;
  if (!sel) return;
  const view = _getInappWebview();
  if (!view) return;
  const js = `(function(){ var el = document.querySelector(${JSON.stringify(sel)}); if (el && el.parentNode) { el.parentNode.removeChild(el); return true; } return false; })();`;
  try {
    await view.executeJavaScript(js, true);
  } catch (_) {}
  _recordPatch({
    op: 'remove',
    selector: sel
  });
  _clearBrowserSelection();
  toast('Removed', 'success', {
    duration: 1200
  });
}
async function _inspectScrollSelected() {
  const sel = state._inspectActiveSelector;
  if (!sel) return;
  const view = _getInappWebview();
  if (!view) return;
  const js = `(function(){ var el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return true; })();`;
  try {
    await view.executeJavaScript(js, true);
  } catch (_) {}
}

// ── Inline text editor ──────────────────────────────────────────────────
state._inspectIsEditing = false;
state._inspectEditStartHtml = '';
state._inspectEditingSelector = '';
state._inspectWasInspectOnBeforeEdit = false;
async function _inspectToggleEdit() {
  // While editing, we already have the target - ignore the live selector
  // (which may have been cleared when we paused inspect mode on entry).
  const sel = state._inspectIsEditing ? state._inspectEditingSelector : state._inspectActiveSelector;
  if (!sel) {
    toast('Select an element first', 'info', {
      duration: 1200
    });
    return;
  }
  const view = _getInappWebview();
  if (!view) return;
  const btn = document.getElementById('inspectEditBtn');
  if (!state._inspectIsEditing) {
    // Enter edit mode. Inspect mode captures clicks globally, so pause it.
    state._inspectWasInspectOnBeforeEdit = _browserInspectState.enabled;
    if (_browserInspectState.enabled) toggleInappInspectMode(false);
    const entered = await view.executeJavaScript(`(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.contentEditable = 'true';
      el.dataset.symEditing = '1';
      el.style.setProperty('outline', '2px solid #a6e3a1', 'important');
      el.style.setProperty('outline-offset', '2px', 'important');
      el.style.setProperty('cursor', 'text', 'important');
      el.focus({ preventScroll: false });
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var s = window.getSelection();
        s.removeAllRanges(); s.addRange(range);
      } catch (_) {}
      // Floating "Done editing" button pinned above the element so there's
      // always a visible way out, independent of the host's inspect panel.
      var done = document.createElement('button');
      done.id = '__symphoneeEditDone';
      done.type = 'button';
      done.textContent = 'Done editing';
      done.contentEditable = 'false';
      done.style.cssText = 'position:fixed;z-index:2147483647;padding:8px 14px;border-radius:18px;border:1px solid rgba(166,227,161,0.6);background:#1d3a28;color:#a6e3a1;font:600 12px system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,0.35);';
      function pinBtn(){
        var r = el.getBoundingClientRect();
        var top = Math.max(8, r.top - 40);
        var left = Math.min(window.innerWidth - 140, Math.max(8, r.left));
        done.style.top = top + 'px';
        done.style.left = left + 'px';
      }
      pinBtn();
      window.addEventListener('scroll', pinBtn, true);
      window.addEventListener('resize', pinBtn, true);
      done.addEventListener('mousedown', function(ev){ ev.preventDefault(); });
      done.addEventListener('click', function(ev){
        ev.preventDefault(); ev.stopPropagation();
        console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: 'Escape' }));
      });
      // Local Esc handler so focus-inside-the-element Esc still exits.
      function onEditKey(ev){
        if (ev.key === 'Escape') {
          ev.preventDefault(); ev.stopPropagation();
          console.info('__SYMPHONEE_KEY__' + JSON.stringify({ key: 'Escape' }));
        }
      }
      el.addEventListener('keydown', onEditKey, true);
      // Stash refs for the exit path.
      window.__symphoneeEditState = { el: el, done: done, pinBtn: pinBtn, onEditKey: onEditKey };
      document.documentElement.appendChild(done);
      return { html: el.innerHTML };
    })();`, true);
    if (!entered) {
      toast('Element not found', 'error');
      return;
    }
    state._inspectEditStartHtml = entered.html || '';
    state._inspectEditingSelector = sel;
    state._inspectIsEditing = true;
    if (btn) btn.classList.add('inspecting');
    toast('Editing — press Esc or click Done editing to save', 'info', {
      duration: 2400
    });
  } else {
    // Exit edit mode, commit changes.
    const committed = await view.executeJavaScript(`(function(){
      var st = window.__symphoneeEditState;
      var el = (st && st.el) || document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.contentEditable = 'false';
      delete el.dataset.symEditing;
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.style.removeProperty('cursor');
      if (el.blur) el.blur();
      if (st) {
        try { window.removeEventListener('scroll', st.pinBtn, true); } catch(_){}
        try { window.removeEventListener('resize', st.pinBtn, true); } catch(_){}
        try { el.removeEventListener('keydown', st.onEditKey, true); } catch(_){}
        try { if (st.done && st.done.parentNode) st.done.parentNode.removeChild(st.done); } catch(_){}
      }
      var existing = document.getElementById('__symphoneeEditDone');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      window.__symphoneeEditState = null;
      return { html: el.innerHTML };
    })();`, true);
    state._inspectIsEditing = false;
    if (btn) btn.classList.remove('inspecting');
    if (committed && committed.html !== state._inspectEditStartHtml) {
      _recordPatch({
        op: 'html',
        selector: sel,
        html: committed.html
      });
      toast('Edit saved', 'success', {
        duration: 1200
      });
    } else {
      toast('No changes', 'info', {
        duration: 1000
      });
    }
    state._inspectEditStartHtml = '';
    state._inspectEditingSelector = '';
    if (state._inspectWasInspectOnBeforeEdit) toggleInappInspectMode(true);
  }
}
async function _applyInspectStyle(selector, prop, value) {
  const view = _getInappWebview();
  if (!view) return;
  const js = `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.style.setProperty(${JSON.stringify(prop)}, ${JSON.stringify(String(value || ''))}); return true; })();`;
  try {
    await view.executeJavaScript(js, true);
  } catch (_) {}
  _recordPatch({
    op: 'style',
    selector,
    prop,
    value
  });
  _renderInspectBoxModel(selector).catch(() => {});
}

// ── Color popover ────────────────────────────────────────────────────────
state._colorPopoverEl = null;
function _closeColorPopover() {
  if (state._colorPopoverEl) {
    state._colorPopoverEl.remove();
    state._colorPopoverEl = null;
  }
  document.removeEventListener('mousedown', _colorPopoverClickAway, true);
}
function _colorPopoverClickAway(ev) {
  if (state._colorPopoverEl && !state._colorPopoverEl.contains(ev.target)) _closeColorPopover();
}
function _openColorEditorAtChip(chipEl, selector, prop, initialHex) {
  _closeColorPopover();
  const rect = chipEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'sym-color-popover';
  const palette = _inappToolsState.brand && _inappToolsState.brand.palette || [];
  const swatchHtml = palette.length ? `<div class="sym-color-popover-title">Brand palette</div><div class="swatches">${palette.slice(0, 12).map(p => `<div class="sw" style="background:${_escapeHtml(p.hex)}" title="${_escapeHtml(p.hex)} — ${_escapeHtml(p.role)}" data-hex="${_escapeHtml(p.hex)}"></div>`).join('')}</div>` : '';
  pop.innerHTML = `
    <div class="sym-color-popover-title">${_escapeHtml(prop)}</div>
    <input type="color" value="${_escapeHtml(initialHex || '#000000')}">
    <input class="hex" type="text" value="${_escapeHtml(initialHex || '')}" spellcheck="false">
    ${swatchHtml}
  `;
  document.body.appendChild(pop);
  const popW = pop.offsetWidth || 240;
  const left = Math.min(window.innerWidth - popW - 8, Math.max(8, rect.left));
  const top = Math.min(window.innerHeight - pop.offsetHeight - 8, rect.bottom + 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  state._colorPopoverEl = pop;
  const colorInput = pop.querySelector('input[type="color"]');
  const hexInput = pop.querySelector('input.hex');
  function apply(hex) {
    hexInput.value = hex;
    colorInput.value = hex;
    _applyInspectStyle(selector, prop, hex);
    chipEl.style.background = hex;
  }
  colorInput.oninput = () => apply(colorInput.value);
  hexInput.oninput = () => {
    const v = hexInput.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) apply(v.startsWith('#') ? v : '#' + v);
  };
  pop.querySelectorAll('.sw').forEach(sw => {
    sw.onclick = () => apply(sw.dataset.hex);
  });
  setTimeout(() => document.addEventListener('mousedown', _colorPopoverClickAway, true), 0);
}
function _rgbToHex(rgb) {
  if (!rgb) return null;
  const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return /^#[0-9a-fA-F]{3,8}$/.test(rgb) ? rgb : null;
  const h = v => {
    const x = parseInt(v, 10).toString(16);
    return x.length < 2 ? '0' + x : x;
  };
  return '#' + h(m[1]) + h(m[2]) + h(m[3]);
}

// ── QuickView popover ────────────────────────────────────────────────────
state._quickviewEl = null;
function _quickviewHide() {
  if (state._quickviewEl) {
    state._quickviewEl.remove();
    state._quickviewEl = null;
  }
}
function _quickviewShow(ev, prop, value) {
  _quickviewHide();
  let content = '';
  const urlMatch = String(value).match(/url\((['"]?)([^'")]+)\1\)/);
  if (urlMatch && /^(https?:|data:)/.test(urlMatch[2])) {
    content = `<img src="${_escapeHtml(urlMatch[2])}" alt=""/>`;
  } else if (/^(rgb|hsl|#[0-9a-f])/i.test(String(value).trim())) {
    content = `<div class="sq-color" style="background:${_escapeHtml(value)}"></div><div style="font:10px var(--font-mono);margin-top:4px;">${_escapeHtml(value)}</div>`;
  } else {
    const bez = String(value).match(/cubic-bezier\(([^)]+)\)/);
    if (bez) {
      const pts = bez[1].split(',').map(s => parseFloat(s));
      if (pts.length === 4 && pts.every(n => !isNaN(n))) {
        content = `<svg width="160" height="80" viewBox="0 0 160 80"><path d="M 0 80 C ${pts[0] * 160} ${80 - pts[1] * 80}, ${pts[2] * 160} ${80 - pts[3] * 80}, 160 0" fill="none" stroke="#89b4fa" stroke-width="2"/></svg><div style="font:10px var(--font-mono);margin-top:4px;">${_escapeHtml(value)}</div>`;
      }
    }
  }
  if (!content) return;
  const qv = document.createElement('div');
  qv.className = 'sym-quickview';
  qv.innerHTML = content;
  document.body.appendChild(qv);
  const r = ev.target.getBoundingClientRect();
  const top = Math.min(window.innerHeight - qv.offsetHeight - 8, r.bottom + 6);
  const left = Math.min(window.innerWidth - qv.offsetWidth - 8, r.left);
  qv.style.left = left + 'px';
  qv.style.top = top + 'px';
  state._quickviewEl = qv;
}

// ── Property docs ────────────────────────────────────────────────────────
const _PROP_DOCS = {
  'color': {
    sum: 'Sets the foreground (text) color.',
    vals: '<color> | currentColor | inherit'
  },
  'background-color': {
    sum: 'Sets the background color.',
    vals: '<color> | transparent | currentColor'
  },
  'background-image': {
    sum: 'One or more background images. Multiple images stack, first on top.',
    vals: 'none | <image> | url() | linear-gradient() | radial-gradient()'
  },
  'font-family': {
    sum: 'Prioritized list of font families.',
    vals: '<family-name>, <generic> (serif | sans-serif | monospace)'
  },
  'font-size': {
    sum: 'Size of the text.',
    vals: '<length> | <percentage> | xx-small..xx-large'
  },
  'font-weight': {
    sum: 'Weight (boldness) of the font.',
    vals: '100..900 | normal | bold | lighter | bolder'
  },
  'line-height': {
    sum: 'Distance between lines of text.',
    vals: 'normal | <number> | <length> | <percentage>'
  },
  'letter-spacing': {
    sum: 'Horizontal spacing between characters.',
    vals: 'normal | <length>'
  },
  'text-transform': {
    sum: 'Capitalization.',
    vals: 'none | capitalize | uppercase | lowercase'
  },
  'text-align': {
    sum: 'Horizontal alignment of inline content.',
    vals: 'left | right | center | justify | start | end'
  },
  'padding': {
    sum: 'Space inside the border. Shorthand 1-4 values.',
    vals: '<length> | <percentage>'
  },
  'margin': {
    sum: 'Space outside the border. auto centers.',
    vals: '<length> | <percentage> | auto'
  },
  'border': {
    sum: 'Shorthand for border-width/style/color.',
    vals: '<line-width> <line-style> <color>'
  },
  'border-radius': {
    sum: 'Rounds the corners.',
    vals: '<length> | <percentage>'
  },
  'box-shadow': {
    sum: 'Drop shadow. Multiple comma-separated.',
    vals: '[inset?] <x> <y> <blur> <spread>? <color>'
  },
  'opacity': {
    sum: 'Transparency of the element and all children.',
    vals: '0 .. 1'
  },
  'display': {
    sum: 'How the element participates in layout.',
    vals: 'block | inline | inline-block | flex | grid | none | contents'
  },
  'position': {
    sum: 'Positioning scheme.',
    vals: 'static | relative | absolute | fixed | sticky'
  },
  'z-index': {
    sum: 'Stacking order on the Z axis.',
    vals: 'auto | <integer>'
  },
  'width': {
    sum: 'Inner width of the content box.',
    vals: '<length> | <percentage> | auto | min/max/fit-content'
  },
  'height': {
    sum: 'Inner height of the content box.',
    vals: '<length> | <percentage> | auto | min/max-content'
  },
  'cursor': {
    sum: 'Mouse cursor on hover.',
    vals: 'auto | pointer | text | move | grab | not-allowed | ...'
  },
  'transform': {
    sum: 'Geometric transforms.',
    vals: 'translate() | scale() | rotate() | skew() | matrix()'
  },
  'transition': {
    sum: 'Shorthand for transition-*.',
    vals: '<property> <duration> <timing>? <delay>?'
  }
};
state._propdocEl = null;
function _propdocHide() {
  if (state._propdocEl) {
    state._propdocEl.remove();
    state._propdocEl = null;
  }
}
function _propdocShow(ev, targetEl) {
  _propdocHide();
  const prop = targetEl && targetEl.dataset ? targetEl.dataset.prop : '';
  const info = _PROP_DOCS[prop];
  if (!info) return;
  const d = document.createElement('div');
  d.className = 'sym-propdoc';
  d.innerHTML = `<div class="name">${_escapeHtml(prop)}</div><div class="sum">${_escapeHtml(info.sum)}</div><div class="vals">${_escapeHtml(info.vals)}</div>`;
  document.body.appendChild(d);
  const r = targetEl.getBoundingClientRect();
  const left = Math.min(window.innerWidth - d.offsetWidth - 8, r.right + 8);
  const top = Math.min(window.innerHeight - d.offsetHeight - 8, r.top);
  d.style.left = left + 'px';
  d.style.top = top + 'px';
  state._propdocEl = d;
}

// ── Number scrubbing (Alt+drag) ─────────────────────────────────────────
state._scrubState = null;
function _scrubStart(ev, el) {
  if (!ev.altKey) return;
  ev.preventDefault();
  const unit = el.dataset.unit;
  const base = parseFloat(el.dataset.val) || 0;
  const prop = el.parentElement && el.parentElement.dataset ? el.parentElement.dataset.prop : null;
  if (!prop || !state._inspectActiveSelector) return;
  state._scrubState = {
    startX: ev.clientX,
    base,
    unit,
    prop,
    el,
    selector: state._inspectActiveSelector,
    last: base
  };
  document.addEventListener('mousemove', _scrubMove, true);
  document.addEventListener('mouseup', _scrubEnd, true);
  document.body.style.cursor = 'ew-resize';
}
function _scrubMove(ev) {
  if (!state._scrubState) return;
  const delta = ev.clientX - state._scrubState.startX;
  const step = ev.shiftKey ? 10 : 1;
  const next = Math.round((state._scrubState.base + delta * step) * 100) / 100;
  if (next === state._scrubState.last) return;
  state._scrubState.last = next;
  state._scrubState.el.textContent = next;
  _applyInspectStyle(state._scrubState.selector, state._scrubState.prop, next + state._scrubState.unit);
}
function _scrubEnd() {
  document.removeEventListener('mousemove', _scrubMove, true);
  document.removeEventListener('mouseup', _scrubEnd, true);
  document.body.style.cursor = '';
  state._scrubState = null;
}

// ── Saved patches (localStorage per URL) ────────────────────────────────
const _PATCH_STORAGE_KEY = 'symphonee.browser.patches';
function _currentPageKey() {
  const view = _getInappWebview();
  try {
    if (view && view.tagName.toLowerCase() === 'webview' && view.getURL) {
      const u = new URL(view.getURL());
      return u.origin + u.pathname;
    }
  } catch (_) {}
  return '';
}
function _loadAllPatches() {
  try {
    return JSON.parse(localStorage.getItem(_PATCH_STORAGE_KEY) || '{}');
  } catch (_) {
    return {};
  }
}
function _saveAllPatches(all) {
  try {
    localStorage.setItem(_PATCH_STORAGE_KEY, JSON.stringify(all));
  } catch (_) {}
}
function _recordPatch(entry) {
  const key = _currentPageKey();
  if (!key) return;
  const all = _loadAllPatches();
  const list = all[key] || [];
  list.push({
    ...entry,
    at: Date.now()
  });
  all[key] = list.slice(-200);
  _saveAllPatches(all);
}
async function _applyStoredPatch(p) {
  const view = _getInappWebview();
  if (!view) return;
  await _ensureSymKit();
  if (p.op === 'hide') {
    await _symKitCall('setVisibility', p.selector, true);
    return;
  }
  if (p.op === 'remove') {
    const js = `(function(){ var el = document.querySelector(${JSON.stringify(p.selector)}); if (el && el.parentNode) el.parentNode.removeChild(el); })();`;
    try {
      await view.executeJavaScript(js, true);
    } catch (_) {}
    return;
  }
  if (p.op === 'style') {
    const js = `(function(){ var el = document.querySelector(${JSON.stringify(p.selector)}); if (!el) return; el.style.setProperty(${JSON.stringify(p.prop)}, ${JSON.stringify(String(p.value || ''))}); })();`;
    try {
      await view.executeJavaScript(js, true);
    } catch (_) {}
    return;
  }
  if (p.op === 'html') {
    const js = `(function(){ var el = document.querySelector(${JSON.stringify(p.selector)}); if (!el) return; el.innerHTML = ${JSON.stringify(String(p.html || ''))}; })();`;
    try {
      await view.executeJavaScript(js, true);
    } catch (_) {}
  }
}
function _patchSummary(p) {
  const sel = _escapeHtml(String(p.selector || '').slice(0, 70));
  if (p.op === 'style') return `<code style="color:var(--subtext1);">${_escapeHtml(p.prop)}:</code> <strong>${_escapeHtml(String(p.value || '').slice(0, 50))}</strong> on <code style="color:var(--accent);">${sel}</code>`;
  if (p.op === 'html') return `Edited text on <code style="color:var(--accent);">${sel}</code>`;
  if (p.op === 'hide') return `Hid <code style="color:var(--accent);">${sel}</code>`;
  if (p.op === 'remove') return `Removed <code style="color:var(--accent);">${sel}</code>`;
  return `<code>${sel}</code>`;
}
function _patchDetailsHtml(p, realIdx) {
  const kv = [];
  kv.push(`<div class="k">Selector</div><div class="v selector">${_escapeHtml(p.selector || '')}</div>`);
  kv.push(`<div class="k">When</div><div class="v">${new Date(p.at).toLocaleString()}</div>`);
  if (p.op === 'style') {
    kv.push(`<div class="k">Property</div><div class="v">${_escapeHtml(p.prop || '')}</div>`);
    kv.push(`<div class="k">Value</div><div class="v">${_escapeHtml(String(p.value || ''))}</div>`);
  } else if (p.op === 'html') {
    const html = String(p.html || '');
    const preview = html.length > 800 ? html.slice(0, 800) + '...' : html;
    kv.push(`<div class="k">New HTML</div><div class="v code">${_escapeHtml(preview)}</div>`);
  }
  return `
    <div class="sym-patch-body" onclick="event.stopPropagation()">
      <div class="sym-patch-kv">${kv.join('')}</div>
      <div class="sym-patch-actions">
        <button class="sym-patch-btn danger" onclick="_removePatchByIndex(${realIdx})"><i data-lucide="trash-2" style="width:11px;height:11px;"></i> Delete</button>
        <button class="sym-patch-btn primary" onclick="_applyPatchByIndex(${realIdx})"><i data-lucide="play" style="width:11px;height:11px;"></i> Apply</button>
      </div>
    </div>
  `;
}
async function _runInappPatchesPanel() {
  _setInappToolsTitle('Saved patches');
  const key = _currentPageKey();
  if (!key) {
    _setInappToolsBodyHtml('<div class="inapp-tools-empty">Open a page first.</div>');
    return;
  }
  const all = _loadAllPatches();
  const list = all[key] || [];
  _inappToolsState.patches = {
    loaded: key,
    list
  };
  if (!list.length) {
    _setInappToolsBodyHtml(`<div class="inapp-tools-empty"><i data-lucide="history" style="width:24px;height:24px;display:block;margin:0 auto 10px;color:var(--subtext1);"></i>No saved patches for this page yet.<div style="margin-top:8px;font-size:11px;">Use Inspect code to hide, remove, style, or edit elements - they're recorded here automatically.</div></div>`);
    try {
      if (window.lucide && lucide.createIcons) lucide.createIcons();
    } catch (_) {}
    return;
  }
  const chev = '<svg class="sym-patch-chev" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  const rows = list.slice().reverse().map((p, i) => {
    const realIdx = list.length - 1 - i;
    const when = new Date(p.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    return `
      <div class="sym-patch-card" data-patch-id="${realIdx}">
        <div class="sym-patch-head" onclick="this.parentElement.classList.toggle('open')">
          ${chev}
          <span class="sym-patch-op op-${p.op}">${_escapeHtml(p.op)}</span>
          <span class="sym-patch-summary">${_patchSummary(p)}</span>
          <span class="sym-patch-when">${when}</span>
        </div>
        ${_patchDetailsHtml(p, realIdx)}
      </div>
    `;
  }).join('');
  _setInappToolsBodyHtml(`
    <div class="sym-patch-bar">
      <span class="count">${list.length} patch${list.length === 1 ? '' : 'es'} for this URL</span>
      <button class="sym-patch-btn primary" onclick="_applyAllPatches()"><i data-lucide="play" style="width:11px;height:11px;"></i> Apply all</button>
      <button class="sym-patch-btn danger" onclick="_clearAllPatches()"><i data-lucide="trash-2" style="width:11px;height:11px;"></i> Clear all</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">${rows}</div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
async function _applyPatchByIndex(i) {
  const list = _inappToolsState.patches.list || [];
  const p = list[i];
  if (!p) return;
  await _applyStoredPatch(p);
  toast('Patch applied', 'success', {
    duration: 1200
  });
}
function _removePatchByIndex(i) {
  const key = _inappToolsState.patches.loaded;
  const all = _loadAllPatches();
  const list = all[key] || [];
  list.splice(i, 1);
  all[key] = list;
  _saveAllPatches(all);
  _runInappPatchesPanel();
}
async function _applyAllPatches() {
  const list = _inappToolsState.patches.list || [];
  for (const p of list) await _applyStoredPatch(p);
  toast('Applied ' + list.length + ' patches', 'success');
}
function _clearAllPatches() {
  const key = _inappToolsState.patches.loaded;
  const all = _loadAllPatches();
  delete all[key];
  _saveAllPatches(all);
  _runInappPatchesPanel();
}

// ── Dark / grayscale / focus toggles ────────────────────────────────────
// Dark-mode overlay was removed per user feedback (no clear use case).
async function toggleInappGrayscale() {
  _inappToolsState.grayscale = !_inappToolsState.grayscale;
  await _ensureSymKit();
  await _symKitCall('applyGrayscale', _inappToolsState.grayscale);
  const label = document.getElementById('inappGrayToggleLabel');
  if (label) label.textContent = _inappToolsState.grayscale ? 'Grayscale (on)' : 'Grayscale';
}
async function toggleInappFocusMode() {
  _inappToolsState.focus = !_inappToolsState.focus;
  await _ensureSymKit();
  await _symKitCall('applyFocusMode', _inappToolsState.focus);
  const label = document.getElementById('inappFocusToggleLabel');
  if (label) label.textContent = _inappToolsState.focus ? 'Focus mode (on)' : 'Focus mode';
}

// ── Shortcuts help ──────────────────────────────────────────────────────
function showInappShortcutsHelp() {
  const o = document.getElementById('symShortcutsOverlay');
  if (o) o.classList.add('open');
}
function hideInappShortcutsHelp() {
  const o = document.getElementById('symShortcutsOverlay');
  if (o) o.classList.remove('open');
}

// ── Global keyboard shortcuts (Browser tab only; ignores field focus) ───
document.addEventListener('keydown', function (ev) {
  const browserTab = document.getElementById('panel-browser');
  if (!browserTab || !browserTab.classList.contains('active')) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (ev.metaKey || ev.ctrlKey) return;
  if (ev.key === 'Escape') {
    if (state._inspectIsEditing) {
      _inspectToggleEdit();
      ev.preventDefault();
      return;
    }
    if (state._colorPopoverEl) {
      _closeColorPopover();
      ev.preventDefault();
      return;
    }
    const overlay = document.getElementById('symShortcutsOverlay');
    if (overlay && overlay.classList.contains('open')) {
      hideInappShortcutsHelp();
      ev.preventDefault();
      return;
    }
    if (_inappToolsState.open) {
      closeInappToolsPanel();
      ev.preventDefault();
      return;
    }
    if (_browserAgentState.open) {
      toggleBrowserAgentPanel();
      ev.preventDefault();
      return;
    }
    if (_browserInspectState.enabled) {
      toggleInappInspectMode(false);
      ev.preventDefault();
      return;
    }
    return;
  }
  if (ev.key === '?' || ev.key === '/' && ev.shiftKey) {
    showInappShortcutsHelp();
    ev.preventDefault();
    return;
  }
  const k = ev.key.toLowerCase();
  if (k === 'i') {
    toggleInappInspectMode();
    ev.preventDefault();
    return;
  }
  if (k === 'h') {
    if (ev.shiftKey) {
      _ensureSymKit().then(() => _symKitCall('unhideAll'));
      toast('Un-hid all', 'info', {
        duration: 1000
      });
    } else if (state._inspectActiveSelector) _inspectHideSelected();
    ev.preventDefault();
    return;
  }
  if (k === 'g') {
    toggleInappGrayscale();
    ev.preventDefault();
    return;
  }
  if (k === 'f') {
    toggleInappFocusMode();
    ev.preventDefault();
    return;
  }
  if (k === 't') {
    toggleInappToolsPanelMenu();
    ev.preventDefault();
    return;
  }
  if (k === 'k') {
    toggleBrowserAgentPanel();
    ev.preventDefault();
    return;
  }
  if (k === 'e') {
    _inspectToggleEdit();
    ev.preventDefault();
    return;
  }
}, true);// ── Reader view (overlay + scoped minimalist stylesheet) ────────────────
const _READER_FONT_SIZES = ['15px', '17px', '19px', '21px', '24px'];
const _inappReaderState = {
  active: false,
  sizeIdx: 2,
  words: 0,
  minutes: 0,
  rootTag: ''
};
async function _runInappReaderView() {
  _setInappToolsTitle('Reader view');
  _setInappToolsBodyLoading('Building reader view...');
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') {
    _setInappToolsBodyError('Browser not ready.');
    return;
  }
  const script = `(function(){
    var KEY = '__symphoneeReader';
    if (window[KEY]) {
      var prev = document.getElementById('__symphoneeReaderOverlay');
      if (prev) prev.remove();
      try {
        if (window[KEY].prevHtmlOverflow != null) document.documentElement.style.overflow = window[KEY].prevHtmlOverflow;
        if (window[KEY].prevBodyOverflow != null) document.body.style.overflow = window[KEY].prevBodyOverflow;
      } catch (_) {}
      window[KEY] = null;
      return { applied: false };
    }
    // Find the best article root by text length, preferring semantic containers.
    var candidates = ['article', 'main', '[role="main"]', '.post-content', '.article-content', '.entry-content', '.post-body', '.story-body', '.post', '.article', '#content', '#main', '.content', '.page-content'];
    var root = null, rootLen = 0;
    candidates.forEach(function(sel){
      try {
        document.querySelectorAll(sel).forEach(function(el){
          var len = (el.innerText || '').length;
          if (len > rootLen && len > 200) { root = el; rootLen = len; }
        });
      } catch (_) {}
    });
    if (!root) {
      document.querySelectorAll('div, section').forEach(function(el){
        var len = (el.innerText || '').length;
        if (len > rootLen && len > 600) { root = el; rootLen = len; }
      });
    }
    if (!root) root = document.body;
    // Title + byline discovery.
    var titleText = '';
    var h1 = root.querySelector('h1') || document.querySelector('h1, .article-title, .post-title, [itemprop="headline"]');
    if (h1 && h1.innerText) titleText = h1.innerText.trim();
    if (!titleText) titleText = document.title || '';
    var bylineText = '';
    var bylineEl = document.querySelector('[rel="author"], .byline, .author, [itemprop="author"]');
    if (bylineEl && bylineEl.innerText) bylineText = bylineEl.innerText.trim().slice(0, 140);
    var dateText = '';
    var dateEl = document.querySelector('time, [itemprop="datePublished"], .published, .date');
    if (dateEl) dateText = (dateEl.getAttribute('datetime') || dateEl.innerText || '').trim().slice(0, 40);

    // Clone article. Strip junk. Preserve images, figures, lists, quotes, code.
    var clone = root.cloneNode(true);
    var junkSel = [
      'script','style','noscript','form','input','button','select','textarea','nav','aside','header','footer',
      '[aria-hidden="true"]','[role="navigation"]','[role="banner"]','[role="contentinfo"]','[role="complementary"]',
      '.advert','.advertisement','[class*="advert"]','[class*="-ad-"]','[class*="_ad_"]','[class*="promo"]','[class*="newsletter"]',
      '[class*="share"]','[class*="social"]','[class*="related"]','[class*="recommended"]','[class*="comments"]','[class*="sidebar"]',
      '[class*="cookie"]','[class*="popup"]','[class*="modal"]','[class*="overlay"]',
      '[data-component*="newsletter"]','[data-module*="newsletter"]'
    ].join(',');
    clone.querySelectorAll(junkSel).forEach(function(n){ try { n.remove(); } catch(_){} });
    // Also drop the title we lifted separately so it doesn't render twice.
    if (h1 && clone.contains(h1)) try { var x = clone.querySelector('h1'); if (x) x.remove(); } catch(_){}
    // Drop empty elements after cleanup (prevents ghost whitespace blocks).
    clone.querySelectorAll('*').forEach(function(n){
      if (n.children.length === 0 && !(n.innerText || '').trim() && !['IMG','VIDEO','IFRAME','HR','BR'].includes(n.tagName)) {
        try { n.remove(); } catch(_){}
      }
    });
    // Sanitize: drop styles/classes/ids to neutralize source's CSS; make links safe + absolute.
    clone.querySelectorAll('*').forEach(function(n){
      try {
        n.removeAttribute('style');
        n.removeAttribute('class');
        n.removeAttribute('id');
        n.removeAttribute('on' + 'click');
        if (n.tagName === 'A' && n.getAttribute('href')) { n.setAttribute('target','_blank'); n.setAttribute('rel','noopener'); }
      } catch(_){}
    });
    // Resolve relative src/href against origin.
    clone.querySelectorAll('img[src],source[src]').forEach(function(img){
      try { img.setAttribute('src', new URL(img.getAttribute('src'), location.href).href); } catch(_){}
      if (img.getAttribute('srcset')) { try { img.removeAttribute('srcset'); } catch(_){} }
    });

    // Build overlay + scoped stylesheet (scoped via .sym-rv root class so it can't leak).
    var overlay = document.createElement('div');
    overlay.id = '__symphoneeReaderOverlay';
    overlay.className = 'sym-rv';
    var style = document.createElement('style');
    // Minimal, classless-style stylesheet - reads like a Markdown preview.
    // No drop caps, no book/serif typography, no floating buttons.
    style.textContent = [
      '.sym-rv{position:fixed;inset:0;z-index:2147483647;background:#ffffff;overflow:auto;-webkit-font-smoothing:antialiased;}',
      '.sym-rv *{box-sizing:border-box;max-width:100%;}',
      '.sym-rv .rv-wrap{max-width:720px;margin:20px auto 32px;padding:0 20px;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Inter","Helvetica Neue",Arial,sans-serif;color:#1f2328;}',
      '.sym-rv .rv-eyebrow{font-size:12px;color:#6e7681;margin-bottom:4px;}',
      '.sym-rv h1.rv-title{font-size:24px;line-height:1.25;margin:0 0 4px;font-weight:600;color:#1f2328;letter-spacing:-0.005em;}',
      '.sym-rv .rv-meta{font-size:12px;color:#6e7681;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '.sym-rv .rv-meta .rv-dot{width:3px;height:3px;border-radius:50%;background:#d0d7de;}',
      '.sym-rv .rv-body{font-size:inherit;line-height:inherit;color:inherit;}',
      '.sym-rv .rv-body p{margin:0 0 0.7em;}',
      '.sym-rv .rv-body h1,.sym-rv .rv-body h2,.sym-rv .rv-body h3,.sym-rv .rv-body h4,.sym-rv .rv-body h5,.sym-rv .rv-body h6{line-height:1.3;color:#1f2328;font-weight:600;}',
      '.sym-rv .rv-body h1{font-size:1.45em;margin:1em 0 0.35em;}',
      '.sym-rv .rv-body h2{font-size:1.25em;margin:1em 0 0.3em;padding-bottom:0.15em;border-bottom:1px solid #eaeef2;}',
      '.sym-rv .rv-body h3{font-size:1.1em;margin:0.9em 0 0.25em;}',
      '.sym-rv .rv-body h4,.sym-rv .rv-body h5,.sym-rv .rv-body h6{font-size:1em;margin:0.8em 0 0.2em;}',
      '.sym-rv .rv-body a{color:#0969da;text-decoration:underline;text-underline-offset:0.15em;}',
      '.sym-rv .rv-body a:hover{color:#0550ae;}',
      '.sym-rv .rv-body strong{font-weight:600;color:#1f2328;}',
      '.sym-rv .rv-body em{font-style:italic;}',
      '.sym-rv .rv-body ul,.sym-rv .rv-body ol{margin:0 0 0.7em;padding-left:1.4em;}',
      '.sym-rv .rv-body li{margin:0.12em 0;}',
      '.sym-rv .rv-body li > p{margin:0 0 0.25em;}',
      '.sym-rv .rv-body blockquote{margin:0.7em 0;padding:0 0.9em;border-left:3px solid #d0d7de;color:#57606a;}',
      '.sym-rv .rv-body blockquote p{margin:0 0 0.35em;}',
      '.sym-rv .rv-body code{font-family:ui-monospace,"SF Mono","Menlo","Consolas",monospace;font-size:0.88em;background:#f3f4f6;padding:0.1em 0.3em;border-radius:4px;}',
      '.sym-rv .rv-body pre{font-family:ui-monospace,"SF Mono","Menlo","Consolas",monospace;font-size:0.86em;background:#f3f4f6;padding:10px 12px;border-radius:6px;overflow-x:auto;margin:0.7em 0;line-height:1.5;color:#1f2328;}',
      '.sym-rv .rv-body pre code{background:transparent;padding:0;font-size:inherit;}',
      '.sym-rv .rv-body img,.sym-rv .rv-body video{display:block;max-width:100%;height:auto;border-radius:4px;margin:0.7em auto;}',
      '.sym-rv .rv-body figure{margin:0.7em 0;}',
      '.sym-rv .rv-body figcaption{font-size:0.9em;color:#6e7681;margin-top:4px;text-align:center;}',
      '.sym-rv .rv-body hr{border:0;border-top:1px solid #eaeef2;margin:1em 0;}',
      '.sym-rv .rv-body table{width:100%;border-collapse:collapse;margin:0.7em 0;font-size:0.95em;}',
      '.sym-rv .rv-body th,.sym-rv .rv-body td{padding:0.35em 0.6em;border:1px solid #eaeef2;text-align:left;}',
      '.sym-rv .rv-body th{font-weight:600;background:#f6f8fa;}',
      '.sym-rv::-webkit-scrollbar{width:10px;}',
      '.sym-rv::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.2);border-radius:5px;}',
      '.sym-rv::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,0.32);}',
    ].join('\\n');
    overlay.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'rv-wrap';
    var eyebrow = document.createElement('div');
    eyebrow.className = 'rv-eyebrow';
    eyebrow.textContent = location.hostname;
    var h1el = document.createElement('h1');
    h1el.className = 'rv-title';
    h1el.textContent = titleText;
    var meta = document.createElement('div');
    meta.className = 'rv-meta';
    var metaParts = [];
    if (bylineText) metaParts.push(bylineText);
    if (dateText) metaParts.push(dateText);
    // Estimated reading time (200 wpm heuristic).
    var words = (clone.innerText || '').trim().split(/\\s+/).length;
    var mins = Math.max(1, Math.round(words / 200));
    metaParts.push(mins + ' min read');
    metaParts.forEach(function(p, i){
      if (i > 0){ var dot = document.createElement('span'); dot.className = 'rv-dot'; meta.appendChild(dot); }
      var sp = document.createElement('span'); sp.textContent = p; meta.appendChild(sp);
    });
    var body = document.createElement('div');
    body.className = 'rv-body';
    body.appendChild(clone);
    wrap.appendChild(eyebrow);
    wrap.appendChild(h1el);
    wrap.appendChild(meta);
    wrap.appendChild(body);
    overlay.appendChild(wrap);

    // Font size is driven from the Symphonee tools sidebar, not an in-page bar.
    // The sidebar calls __symphoneeReaderSetFontSize(px) via executeJavaScript.
    window.__symphoneeReaderSetFontSize = function(px){
      try { wrap.style.fontSize = px; } catch (_) {}
    };
    document.body.appendChild(overlay);
    overlay.scrollTop = 0;
    // Lock the underlying page scroll so only the overlay scrolls (no double scrollbars).
    var prevHtmlOverflow = document.documentElement.style.overflow;
    var prevBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    window[KEY] = { active: true, prevHtmlOverflow: prevHtmlOverflow, prevBodyOverflow: prevBodyOverflow };
    return { applied: true, rootTag: (root.tagName || '').toLowerCase(), rootLen: rootLen, words: words, minutes: mins };
  })();`;
  let result;
  try {
    result = await view.executeJavaScript(script, true);
  } catch (e) {
    _setInappToolsBodyError('Reader view failed: ' + (e.message || String(e)));
    return;
  }
  const on = !!(result && result.applied);
  _inappReaderState.active = on;
  if (on) {
    _inappReaderState.words = result.words || 0;
    _inappReaderState.minutes = result.minutes || 1;
    _inappReaderState.rootTag = result.rootTag || 'body';
    if (_inappReaderState.sizeIdx == null) _inappReaderState.sizeIdx = 2;
    // Push the current font-size so the reader matches the saved preference.
    _inappReaderSetFontSize(_READER_FONT_SIZES[_inappReaderState.sizeIdx]);
  }
  _renderInappReaderSidebar();
}
function _renderInappReaderSidebar() {
  const on = _inappReaderState.active;
  _setInappToolsBodyHtml(`
    <div style="text-align:center;padding:10px 4px 4px;">
      <i data-lucide="${on ? 'book-open-check' : 'book-open'}" style="width:22px;height:22px;display:block;margin:0 auto 6px;color:var(--accent);"></i>
      <div style="font:600 12px var(--font-ui);color:var(--text);">${on ? 'Reader view on' : 'Reader view off'}</div>
      <div style="font:11px/1.35 var(--font-ui);margin-top:3px;color:var(--subtext0);">${on ? 'Parsed ' + (_inappReaderState.words || 0).toLocaleString() + ' words from &lt;' + _escapeHtml(_inappReaderState.rootTag) + '&gt; &mdash; about ' + (_inappReaderState.minutes || 1) + ' min read.' : 'Click Turn on to parse the current page.'}</div>
    </div>
    <div class="inapp-tools-actions" style="margin:8px -12px -12px;gap:4px;">
      <button class="tab-bar-btn" type="button" onclick="_runInappReaderView()"><i data-lucide="repeat" style="width:13px;height:13px;"></i> ${on ? 'Turn off' : 'Turn on'}</button>
      ${on ? `
        <button class="tab-bar-btn" type="button" id="readerSizeMinus" title="Smaller font"><i data-lucide="minus" style="width:13px;height:13px;"></i></button>
        <button class="tab-bar-btn" type="button" id="readerSizePlus" title="Larger font"><i data-lucide="plus" style="width:13px;height:13px;"></i></button>
      ` : ''}
    </div>
  `);
  if (on) {
    const minus = document.getElementById('readerSizeMinus');
    const plus = document.getElementById('readerSizePlus');
    if (minus) minus.onclick = () => _inappReaderBumpFontSize(-1);
    if (plus) plus.onclick = () => _inappReaderBumpFontSize(+1);
  }
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
function _inappReaderBumpFontSize(delta) {
  const max = _READER_FONT_SIZES.length - 1;
  _inappReaderState.sizeIdx = Math.max(0, Math.min(max, (_inappReaderState.sizeIdx || 2) + delta));
  _inappReaderSetFontSize(_READER_FONT_SIZES[_inappReaderState.sizeIdx]);
  _renderInappReaderSidebar();
}
function _inappReaderSetSizeIdx(idx) {
  const max = _READER_FONT_SIZES.length - 1;
  _inappReaderState.sizeIdx = Math.max(0, Math.min(max, idx));
  _inappReaderSetFontSize(_READER_FONT_SIZES[_inappReaderState.sizeIdx]);
  _renderInappReaderSidebar();
}
function _inappReaderSetFontSize(px) {
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') return;
  try {
    view.executeJavaScript('try{window.__symphoneeReaderSetFontSize && window.__symphoneeReaderSetFontSize(' + JSON.stringify(px) + ');}catch(_){}', true);
  } catch (_) {}
}

// ── Site audit (SEO + performance + a11y) ───────────────────────────────
const _SITE_AUDIT_SCRIPT = `(function(){
  function getMeta(name){ var el = document.querySelector('meta[name="'+name+'"], meta[property="'+name+'"]'); return el ? (el.getAttribute('content') || '') : null; }
  var title = document.title || '';
  var description = getMeta('description');
  var canonical = (document.querySelector('link[rel="canonical"]') || {}).href || null;
  var robots = getMeta('robots');
  var viewport = getMeta('viewport');
  var ogTitle = getMeta('og:title');
  var ogDescription = getMeta('og:description');
  var ogImage = getMeta('og:image');
  var ogType = getMeta('og:type');
  var twitterCard = getMeta('twitter:card');
  var h1s = Array.from(document.querySelectorAll('h1')).map(function(h){ return (h.innerText || '').trim().slice(0, 80); });
  var lang = document.documentElement.getAttribute('lang') || null;
  var images = Array.from(document.querySelectorAll('img'));
  var imagesMissingAlt = images.filter(function(i){ return !i.getAttribute('alt'); }).length;
  var imagesLazy = images.filter(function(i){ return i.getAttribute('loading') === 'lazy'; }).length;
  var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  var timing = nav ? {
    ttfb: Math.round(nav.responseStart - nav.requestStart),
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
    loadEvent: Math.round(nav.loadEventEnd - nav.startTime),
    transferSize: nav.transferSize,
    encodedBodySize: nav.encodedBodySize,
    domInteractive: Math.round(nav.domInteractive - nav.startTime),
  } : null;
  var resources = (performance.getEntriesByType && performance.getEntriesByType('resource')) || [];
  var byType = { script: 0, css: 0, img: 0, font: 0, xhr: 0, other: 0 };
  var totalSize = 0;
  resources.forEach(function(r){
    totalSize += r.transferSize || 0;
    var t = r.initiatorType || 'other';
    if (t === 'script') byType.script++;
    else if (t === 'link' || t === 'css') byType.css++;
    else if (t === 'img' || t === 'imageset') byType.img++;
    else if (t === 'font') byType.font++;
    else if (t === 'xmlhttprequest' || t === 'fetch') byType.xhr++;
    else byType.other++;
  });
  var secure = location.protocol === 'https:';
  var nodeCount = document.querySelectorAll('*').length;
  var buttonsWithoutLabels = Array.from(document.querySelectorAll('button')).filter(function(b){
    return !(b.innerText || '').trim() && !b.getAttribute('aria-label');
  }).length;
  var inputsWithoutLabels = Array.from(document.querySelectorAll('input, select, textarea')).filter(function(el){
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return false;
    if (el.getAttribute('aria-label')) return false;
    var id = el.id;
    if (id && document.querySelector('label[for="'+CSS.escape(id)+'"]')) return false;
    if (el.closest && el.closest('label')) return false;
    return true;
  }).length;
  var headingsOrder = [];
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function(h){
    headingsOrder.push(parseInt(h.tagName.substring(1), 10));
  });
  var headingSkips = 0;
  for (var i = 1; i < headingsOrder.length; i++) {
    if (headingsOrder[i] - headingsOrder[i-1] > 1) headingSkips++;
  }
  return {
    url: location.href,
    host: location.hostname,
    title: title, description: description, canonical: canonical, robots: robots, viewport: viewport,
    lang: lang,
    h1s: h1s, h1Count: h1s.length,
    og: { title: ogTitle, description: ogDescription, image: ogImage, type: ogType },
    twitter: { card: twitterCard },
    images: { total: images.length, missingAlt: imagesMissingAlt, lazy: imagesLazy },
    timing: timing,
    resources: { total: resources.length, byType: byType, totalTransferBytes: totalSize },
    secure: secure,
    nodeCount: nodeCount,
    a11y: { buttonsWithoutLabels: buttonsWithoutLabels, inputsWithoutLabels: inputsWithoutLabels, headingSkips: headingSkips },
  };
})();`;

// ── Emulation panel (device + media + throttle) ─────────────────────────
const _EMULATE_DEVICES = [{
  id: 'off',
  label: 'No override',
  w: 0,
  h: 0,
  dpr: 1,
  mobile: false,
  touch: false
}, {
  id: 'iphone-14',
  label: 'iPhone 14',
  w: 390,
  h: 844,
  dpr: 3,
  mobile: true,
  touch: true
}, {
  id: 'iphone-se',
  label: 'iPhone SE',
  w: 375,
  h: 667,
  dpr: 2,
  mobile: true,
  touch: true
}, {
  id: 'pixel-7',
  label: 'Pixel 7',
  w: 412,
  h: 915,
  dpr: 2.625,
  mobile: true,
  touch: true
}, {
  id: 'ipad',
  label: 'iPad',
  w: 820,
  h: 1180,
  dpr: 2,
  mobile: true,
  touch: true
}, {
  id: 'ipad-pro',
  label: 'iPad Pro 11"',
  w: 834,
  h: 1194,
  dpr: 2,
  mobile: true,
  touch: true
}, {
  id: 'laptop',
  label: 'Laptop (1366x768)',
  w: 1366,
  h: 768,
  dpr: 1,
  mobile: false,
  touch: false
}, {
  id: 'desktop',
  label: 'Desktop (1920x1080)',
  w: 1920,
  h: 1080,
  dpr: 1,
  mobile: false,
  touch: false
}];
const _emulateState = {
  device: 'off',
  colorScheme: '',
  reducedMotion: '',
  contrast: '',
  network: 'no-throttle',
  cpuRate: 1
};
async function _runInappEmulatePanel() {
  _setInappToolsTitle('Emulate device');
  const devOpts = _EMULATE_DEVICES.map(d => `<option value="${d.id}" ${_emulateState.device === d.id ? 'selected' : ''}>${_escapeHtml(d.label)}${d.w ? ' — ' + d.w + '×' + d.h + ' @' + d.dpr + 'x' : ''}</option>`).join('');
  _setInappToolsBodyHtml(`
    <div style="font:11px/1.45 var(--font-ui);color:var(--yellow);background:color-mix(in srgb, var(--yellow) 12%, var(--surface0));border:1px solid color-mix(in srgb, var(--yellow) 35%, transparent);padding:8px 10px;border-radius:var(--radius);display:flex;gap:8px;align-items:flex-start;">
      <i data-lucide="alert-triangle" style="width:14px;height:14px;color:var(--yellow);flex-shrink:0;margin-top:1px;"></i>
      <div><strong>Heads up:</strong> device emulation rides on top of Chromium&rsquo;s DevTools protocol. Some pages flicker or lose layout when overrides are applied. If things look broken, hit <em>Reset all</em> at the bottom.</div>
    </div>
    <div class="code-inspect-group"><div class="code-inspect-group-title">Device</div>
      <div class="quick-edit-grid" style="grid-template-columns: 110px 1fr;">
        <label>Preset</label>
        <select id="emDevice" onchange="_applyEmulateDevice()">${devOpts}</select>
      </div>
    </div>
    <div class="code-inspect-group"><div class="code-inspect-group-title">Media features</div>
      <div class="quick-edit-grid" style="grid-template-columns: 130px 1fr;">
        <label>Color scheme</label>
        <select id="emColor" onchange="_applyEmulateMedia()">
          <option value="" ${_emulateState.colorScheme === '' ? 'selected' : ''}>No override</option>
          <option value="light" ${_emulateState.colorScheme === 'light' ? 'selected' : ''}>light</option>
          <option value="dark" ${_emulateState.colorScheme === 'dark' ? 'selected' : ''}>dark</option>
        </select>
        <label>Reduced motion</label>
        <select id="emMotion" onchange="_applyEmulateMedia()">
          <option value="" ${_emulateState.reducedMotion === '' ? 'selected' : ''}>No override</option>
          <option value="reduce" ${_emulateState.reducedMotion === 'reduce' ? 'selected' : ''}>reduce</option>
          <option value="no-preference" ${_emulateState.reducedMotion === 'no-preference' ? 'selected' : ''}>no-preference</option>
        </select>
        <label>Contrast</label>
        <select id="emContrast" onchange="_applyEmulateMedia()">
          <option value="" ${_emulateState.contrast === '' ? 'selected' : ''}>No override</option>
          <option value="more" ${_emulateState.contrast === 'more' ? 'selected' : ''}>more</option>
          <option value="less" ${_emulateState.contrast === 'less' ? 'selected' : ''}>less</option>
          <option value="no-preference" ${_emulateState.contrast === 'no-preference' ? 'selected' : ''}>no-preference</option>
        </select>
      </div>
    </div>
    <div class="code-inspect-group"><div class="code-inspect-group-title">Throttling</div>
      <div class="quick-edit-grid" style="grid-template-columns: 110px 1fr;">
        <label>Network</label>
        <select id="emNet" onchange="_applyEmulateThrottle()">
          <option value="no-throttle" ${_emulateState.network === 'no-throttle' ? 'selected' : ''}>No throttling</option>
          <option value="4g" ${_emulateState.network === '4g' ? 'selected' : ''}>4G</option>
          <option value="fast-3g" ${_emulateState.network === 'fast-3g' ? 'selected' : ''}>Fast 3G</option>
          <option value="slow-3g" ${_emulateState.network === 'slow-3g' ? 'selected' : ''}>Slow 3G</option>
          <option value="offline" ${_emulateState.network === 'offline' ? 'selected' : ''}>Offline</option>
        </select>
        <label>CPU throttle</label>
        <select id="emCpu" onchange="_applyEmulateThrottle()">
          ${[1, 2, 4, 6, 10, 20].map(r => `<option value="${r}" ${_emulateState.cpuRate === r ? 'selected' : ''}>${r === 1 ? 'No throttling' : r + '× slower'}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="inapp-tools-actions" style="margin:8px -12px -12px;">
      <button class="tab-bar-btn" type="button" onclick="_resetAllEmulation()"><i data-lucide="rotate-ccw" style="width:13px;height:13px;"></i> Reset all</button>
    </div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
async function _applyEmulateDevice() {
  const sel = document.getElementById('emDevice');
  if (!sel) return;
  const id = sel.value;
  const d = _EMULATE_DEVICES.find(x => x.id === id) || _EMULATE_DEVICES[0];
  _emulateState.device = id;
  try {
    if (id === 'off' || !d.w) {
      await fetch('/api/browser/emulate/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reset: true
        })
      });
      toast('Device override off', 'info', {
        duration: 1200
      });
    } else {
      await fetch('/api/browser/emulate/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          width: d.w,
          height: d.h,
          deviceScaleFactor: d.dpr,
          mobile: d.mobile,
          touch: d.touch
        })
      });
      toast(d.label + ' — ' + d.w + '×' + d.h, 'success', {
        duration: 1400
      });
    }
  } catch (e) {
    toast('Emulate failed: ' + e.message, 'error');
  }
}
async function _applyEmulateMedia() {
  _emulateState.colorScheme = (document.getElementById('emColor') || {}).value || '';
  _emulateState.reducedMotion = (document.getElementById('emMotion') || {}).value || '';
  _emulateState.contrast = (document.getElementById('emContrast') || {}).value || '';
  try {
    await fetch('/api/browser/emulate/media', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        colorScheme: _emulateState.colorScheme,
        reducedMotion: _emulateState.reducedMotion,
        contrast: _emulateState.contrast
      })
    });
  } catch (e) {
    toast('Media override failed: ' + e.message, 'error');
  }
}
async function _applyEmulateThrottle() {
  _emulateState.network = (document.getElementById('emNet') || {}).value || 'no-throttle';
  _emulateState.cpuRate = Number((document.getElementById('emCpu') || {}).value || 1);
  try {
    await fetch('/api/browser/emulate/throttle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        network: _emulateState.network,
        cpuRate: _emulateState.cpuRate
      })
    });
  } catch (e) {
    toast('Throttle failed: ' + e.message, 'error');
  }
}
async function _resetAllEmulation() {
  _emulateState.device = 'off';
  _emulateState.colorScheme = '';
  _emulateState.reducedMotion = '';
  _emulateState.contrast = '';
  _emulateState.network = 'no-throttle';
  _emulateState.cpuRate = 1;
  try {
    await Promise.all([fetch('/api/browser/emulate/device', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reset: true
      })
    }), fetch('/api/browser/emulate/media', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    }), fetch('/api/browser/emulate/throttle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        network: 'no-throttle',
        cpuRate: 1
      })
    })]);
    toast('All emulation reset', 'success', {
      duration: 1200
    });
    _runInappEmulatePanel();
  } catch (e) {
    toast('Reset failed: ' + e.message, 'error');
  }
}

// ── Browser issues panel (Audits.issueAdded) ────────────────────────────
async function _runInappIssuesPanel() {
  _setInappToolsTitle('Browser issues');
  _setInappToolsBodyLoading('Starting capture...');
  try {
    await fetch('/api/browser/issues/start', {
      method: 'POST'
    });
  } catch (_) {}
  await _refreshIssuesPanel();
}
async function _refreshIssuesPanel() {
  let data = {
    issues: [],
    count: 0
  };
  try {
    data = await fetch('/api/browser/issues').then(r => r.json());
  } catch (_) {}
  _renderIssuesPanel(data);
}
function _issueSummary(it) {
  const code = it.code || 'Issue';
  const d = it.details || {};
  const details = d.mixedContentIssueDetails || d.contentSecurityPolicyIssueDetails || d.sameSiteCookieIssueDetails || d.lowTextContrastIssueDetails || d.deprecationIssueDetails || d.attributionReportingIssueDetails || d.quirksModeIssueDetails || d.genericIssueDetails || d.heavyAdIssueDetails || {};
  const parts = [];
  if (details.request && details.request.url) parts.push(details.request.url);
  if (details.insecureURL) parts.push(details.insecureURL);
  if (details.cookieUrl) parts.push(details.cookieUrl);
  if (details.violatedDirective) parts.push('directive: ' + details.violatedDirective);
  if (details.blockedURL) parts.push(details.blockedURL);
  if (details.thresholdRatio != null) parts.push('contrast ' + details.thresholdRatio.toFixed(2));
  if (details.reason) parts.push('reason: ' + details.reason);
  if (details.message) parts.push(details.message);
  return {
    code,
    line: parts.join(' · ').slice(0, 180)
  };
}
function _issueSeverity(code) {
  if (/SameSite|ContentSecurityPolicy|MixedContent|Heavy/i.test(code)) return 'error';
  if (/Deprecation|QuirksMode|LowTextContrast/i.test(code)) return 'warn';
  return 'info';
}
function _renderIssuesPanel(data) {
  const issues = data.issues || [];
  if (!issues.length) {
    _setInappToolsBodyHtml(`
      <div class="inapp-tools-empty" style="padding:20px;">
        <i data-lucide="shield-check" style="width:24px;height:24px;display:block;margin:0 auto 10px;color:var(--green);"></i>
        <div style="font-weight:600;color:var(--text);">No issues reported</div>
        <div style="font-size:11px;margin-top:6px;">Chrome's Audits engine is listening. Navigate or reload to capture issues.</div>
      </div>
      <div class="inapp-tools-actions" style="margin:8px -12px -12px;">
        <button class="tab-bar-btn" type="button" onclick="_refreshIssuesPanel()"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> Refresh</button>
      </div>
    `);
    try {
      if (window.lucide && lucide.createIcons) lucide.createIcons();
    } catch (_) {}
    return;
  }
  // Group by code for compactness.
  const byCode = new Map();
  for (const it of issues) {
    const key = it.code || 'Issue';
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(it);
  }
  const cards = [];
  for (const [code, list] of byCode.entries()) {
    const sev = _issueSeverity(code);
    const color = sev === 'error' ? 'var(--red)' : sev === 'warn' ? 'var(--yellow)' : 'var(--accent)';
    const items = list.slice(-20).map(it => {
      const s = _issueSummary(it);
      return `<div style="padding:6px 10px;border-top:1px solid var(--surface0);font:11px var(--font-mono);color:var(--subtext1);">${s.line ? _escapeHtml(s.line) : '<em>no details</em>'}</div>`;
    }).join('');
    cards.push(`
      <div class="sym-patch-card">
        <div class="sym-patch-head">
          <span class="sym-patch-op" style="background:color-mix(in srgb, ${color} 14%, transparent);color:${color};border:1px solid color-mix(in srgb, ${color} 30%, transparent);">${_escapeHtml(sev)}</span>
          <span class="sym-patch-summary">${_escapeHtml(code)}</span>
          <span class="sym-patch-when">${list.length}×</span>
        </div>
        ${items}
      </div>
    `);
  }
  _setInappToolsBodyHtml(`
    <div class="sym-patch-bar">
      <span class="count">${issues.length} issue${issues.length === 1 ? '' : 's'} captured</span>
      <button class="sym-patch-btn" onclick="_refreshIssuesPanel()"><i data-lucide="refresh-cw" style="width:11px;height:11px;"></i> Refresh</button>
      <button class="sym-patch-btn danger" onclick="_clearIssues()"><i data-lucide="trash-2" style="width:11px;height:11px;"></i> Clear</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">${cards.join('')}</div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
async function _clearIssues() {
  try {
    await fetch('/api/browser/issues/clear', {
      method: 'POST'
    });
  } catch (_) {}
  _refreshIssuesPanel();
}
async function _runInappSiteAudit() {
  _setInappToolsTitle('Site audit');
  _setInappToolsBodyLoading('Auditing page...');
  const view = _ensureInappBrowser();
  if (!view || view.tagName.toLowerCase() !== 'webview') {
    _setInappToolsBodyError('Browser not ready.');
    return;
  }
  let data;
  try {
    data = await view.executeJavaScript(_SITE_AUDIT_SCRIPT, true);
  } catch (e) {
    _setInappToolsBodyError('Audit failed: ' + (e.message || String(e)));
    return;
  }
  _inappToolsState.audit = data;
  _renderInappAuditPanel(data);
}
function _fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}
function _fmtMs(n) {
  if (n == null) return '—';
  if (n < 1000) return n + ' ms';
  return (n / 1000).toFixed(2) + ' s';
}
function _auditCheck(pass, warn, text) {
  const status = pass ? 'pass' : warn ? 'warn' : 'fail';
  const color = pass ? 'var(--green)' : warn ? 'var(--yellow)' : 'var(--red)';
  const icon = pass ? 'check-circle-2' : warn ? 'alert-triangle' : 'x-circle';
  return `<div class="audit-check" style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;font:12px var(--font-ui);"><i data-lucide="${icon}" style="width:14px;height:14px;flex-shrink:0;margin-top:2px;color:${color};"></i><span style="color:var(--text);flex:1;min-width:0;">${text}</span></div>`;
}
function _renderInappAuditPanel(d) {
  const seoChecks = [_auditCheck(!!d.title && d.title.length >= 10 && d.title.length <= 70, d.title && (d.title.length > 70 || d.title.length < 10), `<strong>Title:</strong> ${d.title ? d.title.length + ' chars' : 'missing'}${d.title ? ' — ' + _escapeHtml(d.title.slice(0, 60)) + (d.title.length > 60 ? '...' : '') : ''}`), _auditCheck(!!d.description && d.description.length >= 70 && d.description.length <= 170, !!d.description, `<strong>Meta description:</strong> ${d.description ? d.description.length + ' chars' : 'missing (recommend 120-160)'}`), _auditCheck(!!d.canonical, false, `<strong>Canonical:</strong> ${d.canonical ? _escapeHtml(d.canonical) : 'missing'}`), _auditCheck(d.h1Count === 1, d.h1Count > 0, `<strong>H1:</strong> ${d.h1Count} on page${d.h1s[0] ? ' — "' + _escapeHtml(d.h1s[0]) + '"' : ''}`), _auditCheck(!!d.lang, false, `<strong>Lang attribute:</strong> ${d.lang || 'missing'}`), _auditCheck(!!d.viewport, false, `<strong>Viewport meta:</strong> ${d.viewport ? 'set' : 'missing (mobile responsiveness)'}`), _auditCheck(!!(d.og && d.og.title && d.og.description && d.og.image), !!(d.og && (d.og.title || d.og.description)), `<strong>Open Graph:</strong> ${[d.og.title && 'title', d.og.description && 'description', d.og.image && 'image'].filter(Boolean).join(', ') || 'none'}`), _auditCheck(!!(d.twitter && d.twitter.card), false, `<strong>Twitter card:</strong> ${d.twitter && d.twitter.card || 'missing'}`), _auditCheck(d.secure, false, `<strong>HTTPS:</strong> ${d.secure ? 'yes' : 'no (SEO / security penalty)'}`), d.robots ? _auditCheck(!/noindex/i.test(d.robots), /noindex/i.test(d.robots), `<strong>Robots:</strong> ${_escapeHtml(d.robots)}`) : ''].filter(Boolean).join('');
  const perfChecks = d.timing ? [_auditCheck(d.timing.ttfb < 600, d.timing.ttfb < 1500, `<strong>TTFB:</strong> ${_fmtMs(d.timing.ttfb)} <span style="color:var(--subtext0);">(target &lt;600 ms)</span>`), _auditCheck(d.timing.domContentLoaded < 2500, d.timing.domContentLoaded < 5000, `<strong>DOM ready:</strong> ${_fmtMs(d.timing.domContentLoaded)}`), _auditCheck(d.timing.loadEvent < 4000, d.timing.loadEvent < 8000, `<strong>Load event:</strong> ${_fmtMs(d.timing.loadEvent)}`), _auditCheck(d.resources.totalTransferBytes < 2 * 1024 * 1024, d.resources.totalTransferBytes < 5 * 1024 * 1024, `<strong>Transfer size:</strong> ${_fmtBytes(d.resources.totalTransferBytes)} across ${d.resources.total} resources`), _auditCheck(d.nodeCount < 1500, d.nodeCount < 3000, `<strong>DOM size:</strong> ${d.nodeCount.toLocaleString()} elements`)].join('') : '<div class="inapp-tools-empty" style="padding:10px;">No navigation timing available (try reloading the page).</div>';
  const a11yChecks = [_auditCheck(d.images.total === 0 || d.images.missingAlt === 0, d.images.missingAlt < 3, `<strong>Images without alt:</strong> ${d.images.missingAlt} of ${d.images.total}`), _auditCheck(d.a11y.buttonsWithoutLabels === 0, d.a11y.buttonsWithoutLabels < 3, `<strong>Buttons without accessible text:</strong> ${d.a11y.buttonsWithoutLabels}`), _auditCheck(d.a11y.inputsWithoutLabels === 0, d.a11y.inputsWithoutLabels < 3, `<strong>Form inputs without labels:</strong> ${d.a11y.inputsWithoutLabels}`), _auditCheck(d.a11y.headingSkips === 0, d.a11y.headingSkips < 3, `<strong>Heading-level skips:</strong> ${d.a11y.headingSkips}`)].join('');
  const resByType = d.resources.byType;
  const resBreakdown = Object.entries(resByType).filter(([, v]) => v).map(([k, v]) => `<span style="display:inline-block;margin:0 8px 4px 0;padding:2px 8px;border-radius:10px;background:var(--surface0);color:var(--subtext1);font:10px var(--font-mono);">${k}: ${v}</span>`).join('');
  _setInappToolsBodyHtml(`
    <div class="brand-header">
      <div class="brand-header-logo"><i data-lucide="gauge" style="width:22px;height:22px;color:var(--accent);"></i></div>
      <div style="min-width:0;flex:1;">
        <div class="brand-header-name">${_escapeHtml(d.title || d.host)}</div>
        <div class="brand-header-url">${_escapeHtml(d.host)}</div>
      </div>
    </div>
    <div class="brand-section-title">SEO</div>
    <div class="code-inspect-group"><div style="padding:4px 10px;">${seoChecks}</div></div>
    <div class="brand-section-title">Performance</div>
    <div class="code-inspect-group"><div style="padding:4px 10px;">${perfChecks}</div></div>
    ${resBreakdown ? '<div style="padding:0 2px;">' + resBreakdown + '</div>' : ''}
    <div class="brand-section-title">Accessibility</div>
    <div class="code-inspect-group"><div style="padding:4px 10px;">${a11yChecks}</div></div>
    <div class="inapp-tools-actions" style="margin:8px -12px -12px;">
      <button class="tab-bar-btn" type="button" onclick="_saveAuditToNote()"><i data-lucide="save" style="width:13px;height:13px;"></i> Save to note</button>
      <button class="tab-bar-btn" type="button" onclick="_runInappSiteAudit()"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i> Re-run</button>
    </div>
  `);
  try {
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  } catch (_) {}
}
async function _saveAuditToNote() {
  const d = _inappToolsState.audit;
  if (!d) return;
  const lines = [];
  lines.push(`# Site audit — ${d.title || d.host}`);
  lines.push('');
  lines.push(`**URL:** ${d.url}`);
  lines.push(`**Captured:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## SEO');
  lines.push(`- Title: ${d.title ? `"${d.title}" (${d.title.length} chars)` : '**missing**'}`);
  lines.push(`- Meta description: ${d.description ? `${d.description.length} chars` : '**missing**'}`);
  lines.push(`- Canonical: ${d.canonical || '**missing**'}`);
  lines.push(`- H1 count: ${d.h1Count}${d.h1s[0] ? ` — "${d.h1s[0]}"` : ''}`);
  lines.push(`- Lang: ${d.lang || '**missing**'}`);
  lines.push(`- Viewport meta: ${d.viewport || '**missing**'}`);
  lines.push(`- Open Graph: ${[d.og.title && 'title', d.og.description && 'description', d.og.image && 'image', d.og.type && 'type'].filter(Boolean).join(', ') || 'none'}`);
  lines.push(`- Twitter card: ${d.twitter && d.twitter.card || 'missing'}`);
  lines.push(`- HTTPS: ${d.secure ? 'yes' : '**no**'}`);
  if (d.robots) lines.push(`- Robots: ${d.robots}`);
  lines.push('');
  lines.push('## Performance');
  if (d.timing) {
    lines.push(`- TTFB: ${_fmtMs(d.timing.ttfb)}`);
    lines.push(`- DOM ready: ${_fmtMs(d.timing.domContentLoaded)}`);
    lines.push(`- Load event: ${_fmtMs(d.timing.loadEvent)}`);
    lines.push(`- DOM interactive: ${_fmtMs(d.timing.domInteractive)}`);
    lines.push(`- Transfer size (navigation): ${_fmtBytes(d.timing.transferSize)}`);
  }
  lines.push(`- Total resource transfer: ${_fmtBytes(d.resources.totalTransferBytes)} across ${d.resources.total} requests`);
  Object.entries(d.resources.byType).filter(([, v]) => v).forEach(([k, v]) => lines.push(`  - ${k}: ${v}`));
  lines.push(`- DOM size: ${d.nodeCount} elements`);
  lines.push('');
  lines.push('## Accessibility');
  lines.push(`- Images missing alt: ${d.images.missingAlt} / ${d.images.total}`);
  lines.push(`- Buttons without accessible text: ${d.a11y.buttonsWithoutLabels}`);
  lines.push(`- Form inputs without labels: ${d.a11y.inputsWithoutLabels}`);
  lines.push(`- Heading-level skips: ${d.a11y.headingSkips}`);
  const name = 'Audit — ' + (d.title || d.host).replace(/[^\w\s-]/g, '').slice(0, 70);
  try {
    await notesFetch('/api/notes/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name
      })
    });
    await notesFetch('/api/notes/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        content: lines.join('\n')
      })
    });
    toast('Saved to note: ' + name, 'success');
  } catch (e) {
    toast('Save failed: ' + (e.message || String(e)), 'error');
  }
}

// Lazy-create the webview on first tab activation so we do not pay the cost
// at app boot.
(function wireInappBrowserOnActivate() {
  const panel = document.getElementById('panel-browser');
  if (!panel) return;
  const obs = new MutationObserver(() => {
    if (panel.classList.contains('active')) {
      _ensureInappBrowser();
    }
  });
  obs.observe(panel, {
    attributes: true,
    attributeFilter: ['class']
  });
})();// ── Spaces (non-git workspaces) ─────────────────────────────────────────
const CORE_SPACE_PLUGIN_IDS = new Set(['browser-use', 'video-use', 'stagehand']);
function isCoreSpacePluginId(id) {
  return CORE_SPACE_PLUGIN_IDS.has(id);
}
// Single wizard handles both create and edit. In edit mode it pre-populates
// identity, repos, and plugins from the existing space so the user can adjust
// any of them in one place (matches the create flow 1:1).
async function openAddSpaceDialog(opts = {}) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isEdit = !!opts.edit;
  const originalName = isEdit ? opts.name || '' : null;
  let step = 1;
  const state = {
    name: opts.name || '',
    description: opts.description || '',
    icon: opts.icon || 'layers',
    repos: Array.isArray(opts.repos) ? opts.repos.slice() : [],
    plugins: Array.isArray(opts.plugins) ? opts.plugins.slice() : []
  };
  const [allRepos, allSpaces, allPlugins] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({})), fetch('/api/plugins').then(r => r.json()).catch(() => [])]);
  // In edit mode, repos already in THIS space should still be selectable
  // (they're "taken" by this space, but the user is editing this space).
  const takenRepos = new Set(Object.entries(allSpaces).filter(([n]) => !isEdit || n !== originalName).flatMap(([, s]) => s.repos || []));
  const freeRepos = Object.keys(allRepos).filter(r => !takenRepos.has(r));
  const pluginList = (Array.isArray(allPlugins) ? allPlugins : []).filter(p => p && !isCoreSpacePluginId(p.id));
  const originalRepos = isEdit ? Array.isArray(opts.repos) ? opts.repos.slice() : [] : [];
  let overlay = document.getElementById('_asoOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = '_asoOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:4000;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  document.body.appendChild(overlay);
  const ASO_ICONS = [{
    n: 'layers',
    l: 'General'
  }, {
    n: 'briefcase',
    l: 'Work'
  }, {
    n: 'folder',
    l: 'Folder'
  }, {
    n: 'user',
    l: 'Personal'
  }, {
    n: 'users',
    l: 'Team'
  }, {
    n: 'code-2',
    l: 'Code'
  }, {
    n: 'terminal',
    l: 'Terminal'
  }, {
    n: 'globe',
    l: 'Web'
  }, {
    n: 'smartphone',
    l: 'Mobile'
  }, {
    n: 'database',
    l: 'Data'
  }, {
    n: 'server',
    l: 'Infra'
  }, {
    n: 'cloud',
    l: 'Cloud'
  }, {
    n: 'shield',
    l: 'Security'
  }, {
    n: 'rocket',
    l: 'Startup'
  }, {
    n: 'star',
    l: 'Favorites'
  }, {
    n: 'building-2',
    l: 'Company'
  }, {
    n: 'palette',
    l: 'Design'
  }, {
    n: 'book-open',
    l: 'Docs'
  }, {
    n: 'cpu',
    l: 'AI / ML'
  }, {
    n: 'zap',
    l: 'Fast'
  }, {
    n: 'package',
    l: 'Packages'
  }, {
    n: 'git-branch',
    l: 'Git'
  }, {
    n: 'layout-dashboard',
    l: 'Dashboard'
  }, {
    n: 'music',
    l: 'Creative'
  }, {
    n: 'flask-conical',
    l: 'Experiment'
  }];
  function renderStep() {
    const STEP_LABELS = ['Identity', 'Repos', 'Plugins'];
    const stepDotsHtml = STEP_LABELS.map((lbl, i) => {
      const n = i + 1,
        active = n === step,
        done = n < step;
      const bg = done || active ? 'var(--accent)' : 'var(--surface2)';
      const fg = done || active ? 'var(--crust)' : 'var(--subtext0)';
      const inner = done ? '<i data-lucide="check" style="width:10px;height:10px;"></i>' : n;
      const line = n < 3 ? `<div style="width:20px;height:1px;background:${n < step ? 'var(--accent)' : 'var(--surface2)'};margin:0 6px;"></div>` : '';
      return `<div style="display:flex;align-items:center;">
        <div style="display:flex;align-items:center;gap:5px;">
          <div style="width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;background:${bg};color:${fg};">${inner}</div>
          <span style="font-size:11px;font-weight:${active ? '700' : '500'};color:${active ? 'var(--text)' : 'var(--subtext0)'};">${lbl}</span>
        </div>${line}
      </div>`;
    }).join('');
    let bodyHtml = '';
    if (step === 1) {
      const iconGridHtml = ASO_ICONS.map(ico => {
        const sel = ico.n === state.icon;
        return `<button type="button" data-pick-icon="${esc(ico.n)}" title="${esc(ico.l)}" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
          width:52px;height:52px;border-radius:8px;border:1px solid ${sel ? 'var(--accent)' : 'var(--surface2)'};
          background:${sel ? 'color-mix(in srgb,var(--accent) 15%,var(--surface1))' : 'var(--surface1)'};
          cursor:pointer;padding:0;transition:border-color 0.12s,background 0.12s;">
          <i data-lucide="${esc(ico.n)}" style="width:15px;height:15px;color:${sel ? 'var(--accent)' : 'var(--subtext1)'};"></i>
          <span style="font-size:9px;color:${sel ? 'var(--accent)' : 'var(--subtext0)'};font-family:var(--font-ui);line-height:1.1;text-align:center;padding:0 2px;">${esc(ico.l)}</span>
        </button>`;
      }).join('');
      bodyHtml = `
        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--subtext1);margin-bottom:5px;">Name <span style="color:var(--red);">*</span></label>
          <input id="_asoName" type="text" value="${esc(state.name)}" placeholder="e.g. Personal, Work, Bath Fitter"
            style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface1);border:1px solid var(--surface2);border-radius:var(--radius);color:var(--text);font:13px var(--font-ui);outline:none;transition:border-color 0.12s;"
            onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--surface2)'"
            oninput="document.getElementById('_asoNameErr').style.display='none'">
          <div id="_asoNameErr" style="display:none;color:var(--red);font-size:10px;margin-top:3px;">Name is required.</div>
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--subtext1);margin-bottom:5px;">Description <span style="color:var(--subtext0);font-weight:400;">(optional)</span></label>
          <input id="_asoDesc" type="text" value="${esc(state.description)}" placeholder="Short description"
            style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface1);border:1px solid var(--surface2);border-radius:var(--radius);color:var(--text);font:13px var(--font-ui);outline:none;transition:border-color 0.12s;"
            onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--surface2)'">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--subtext1);margin-bottom:8px;">Icon</label>
          <div style="display:grid;grid-template-columns:repeat(5,52px);gap:6px;">${iconGridHtml}</div>
        </div>`;
    } else if (step === 2) {
      const items = freeRepos.length ? freeRepos.map(r => {
        const chk = state.repos.includes(r);
        return `<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:6px;cursor:pointer;">
              <input type="checkbox" data-asr="${esc(r)}" ${chk ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;">
              <i data-lucide="folder-git-2" style="width:13px;height:13px;color:var(--accent);flex-shrink:0;"></i>
              <span style="font:12px var(--font-ui);color:var(--text);">${esc(r)}</span>
            </label>`;
      }).join('') : '<div style="padding:12px 10px;color:var(--subtext0);font-size:11px;">All repos are already assigned to a space. Add more repos in Settings.</div>';
      bodyHtml = `
        <p style="font-size:11px;color:var(--subtext0);margin:0 0 10px;line-height:1.5;">Select which repos belong to this space. A repo can only belong to one space at a time.</p>
        <div style="max-height:240px;overflow-y:auto;border:1px solid var(--surface1);border-radius:var(--radius);padding:4px;">${items}</div>`;
    } else if (step === 3) {
      const items = pluginList.length ? pluginList.map(p => {
        const chk = state.plugins.includes(p.id);
        return `<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:6px;cursor:pointer;">
              <input type="checkbox" data-asp="${esc(p.id)}" ${chk ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;">
              <i data-lucide="${esc(p.icon || 'puzzle')}" style="width:13px;height:13px;color:var(--accent);flex-shrink:0;"></i>
              <span style="font:12px var(--font-ui);color:var(--text);">${esc(p.name || p.id)}</span>
            </label>`;
      }).join('') : '<div style="padding:12px 10px;color:var(--subtext0);font-size:11px;">No plugins installed. Install plugins from Settings &rsaquo; Plugins.</div>';
      bodyHtml = `
        <p style="font-size:11px;color:var(--subtext0);margin:0 0 10px;line-height:1.5;">Choose which plugins are surfaced while this space is active. Leave all unchecked to show every plugin. Browser tools are always available and are not listed here.</p>
        <div style="max-height:240px;overflow-y:auto;border:1px solid var(--surface1);border-radius:var(--radius);padding:4px;">${items}</div>`;
    }
    const backBtn = step > 1 ? `<button onclick="window._asoBack()" style="display:inline-flex;align-items:center;gap:5px;padding:0 12px;height:30px;background:var(--surface1);border:1px solid var(--surface2);border-radius:var(--radius-lg);color:var(--text);font:600 12px var(--font-ui);cursor:pointer;">
          <i data-lucide="arrow-left" style="width:12px;height:12px;"></i> Back
        </button>` : '';
    const isLast = step === 3;
    const nextLabel = isLast ? isEdit ? 'Save' : 'Create Space' : 'Next';
    const nextArrow = isLast ? '' : ' <i data-lucide="arrow-right" style="width:12px;height:12px;"></i>';
    const headerTitle = isEdit ? 'Edit Space' + (originalName ? ': ' + esc(originalName) : '') : 'New Space';
    overlay.innerHTML = `
      <div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:var(--radius-lg);padding:24px;width:390px;max-width:calc(100vw - 40px);box-shadow:0 16px 48px rgba(0,0,0,0.5);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
          <i data-lucide="layers" style="width:16px;height:16px;color:var(--accent);"></i>
          <strong style="font-size:14px;color:var(--text);font-family:var(--font-ui);">${headerTitle}</strong>
          <div style="flex:1;"></div>
          <button onclick="window._asoDismiss()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:2px;display:flex;align-items:center;">
            <i data-lucide="x" style="width:14px;height:14px;"></i>
          </button>
        </div>
        <div style="display:flex;align-items:center;margin-bottom:20px;">${stepDotsHtml}</div>
        <div>${bodyHtml}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:20px;">
          <button onclick="window._asoDismiss()" style="display:inline-flex;align-items:center;padding:0 12px;height:30px;background:transparent;border:1px solid transparent;border-radius:var(--radius-lg);color:var(--subtext0);font:500 12px var(--font-ui);cursor:pointer;">Cancel</button>
          <div style="flex:1;"></div>
          ${backBtn}
          <button onclick="window._asoNext()" style="display:inline-flex;align-items:center;gap:5px;padding:0 14px;height:30px;background:var(--accent);border:1px solid var(--accent);border-radius:var(--radius-lg);color:var(--crust);font:600 12px var(--font-ui);cursor:pointer;">${nextLabel}${nextArrow}</button>
        </div>
      </div>`;
    try {
      lucide.createIcons({
        nodes: [overlay]
      });
    } catch (_) {}
    overlay.querySelectorAll('[data-pick-icon]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.icon = btn.dataset.pickIcon;
        renderStep();
      });
    });
    if (step === 1) {
      setTimeout(() => {
        const el = document.getElementById('_asoName');
        if (el) el.focus();
      }, 30);
    }
  }
  window._asoNext = function () {
    if (step === 1) {
      state.name = (document.getElementById('_asoName')?.value || '').trim();
      state.description = (document.getElementById('_asoDesc')?.value || '').trim();
      if (!state.name) {
        const e = document.getElementById('_asoNameErr');
        if (e) e.style.display = '';
        return;
      }
      step = 2;
      renderStep();
    } else if (step === 2) {
      state.repos = [...overlay.querySelectorAll('[data-asr]:checked')].map(el => el.dataset.asr);
      step = 3;
      renderStep();
    } else if (step === 3) {
      state.plugins = [...overlay.querySelectorAll('[data-asp]:checked')].map(el => el.dataset.asp);
      _asoSubmit();
    }
  };
  window._asoBack = function () {
    if (step === 2) {
      state.repos = [...overlay.querySelectorAll('[data-asr]:checked')].map(el => el.dataset.asr);
      step = 1;
    } else if (step === 3) {
      state.plugins = [...overlay.querySelectorAll('[data-asp]:checked')].map(el => el.dataset.asp);
      step = 2;
    }
    renderStep();
  };
  window._asoDismiss = function () {
    overlay.remove();
    ['_asoNext', '_asoBack', '_asoDismiss'].forEach(k => delete window[k]);
  };
  async function _asoSubmit() {
    if (isEdit) {
      // Rename: delete old, create new carrying the chosen repos/plugins.
      // No rename: POST with all fields to upsert identity + plugins. Repos
      // go through /attach-repo so single-membership invariants are preserved.
      try {
        if (state.name !== originalName) {
          await fetch('/api/spaces', {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: originalName
            })
          });
          await fetch('/api/spaces', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: state.name,
              description: state.description,
              icon: state.icon,
              repos: state.repos,
              plugins: state.plugins
            })
          });
          if (window.state.activeSpace === originalName) {
            window.state.activeSpace = state.name;
            try {
              localStorage.setItem('symphonee-space', window.state.activeSpace);
            } catch (_) {}
          }
        } else {
          await fetch('/api/spaces', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: state.name,
              description: state.description,
              icon: state.icon,
              plugins: state.plugins
            })
          });
          const before = new Set(originalRepos);
          const after = new Set(state.repos);
          const added = [...after].filter(r => !before.has(r));
          const removed = [...before].filter(r => !after.has(r));
          for (const repo of added) {
            await fetch('/api/spaces/attach-repo', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                space: state.name,
                repo,
                attach: true
              })
            });
          }
          for (const repo of removed) {
            await fetch('/api/spaces/attach-repo', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                space: state.name,
                repo,
                attach: false
              })
            });
          }
        }
        toast('Space updated', 'success');
      } catch (e) {
        toast('Failed to update space: ' + (e.message || String(e)), 'error');
        return;
      }
    } else {
      const res = await fetch('/api/spaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: state.name,
          description: state.description,
          icon: state.icon,
          repos: state.repos,
          plugins: state.plugins
        })
      });
      if (!res.ok) {
        toast('Failed to create space', 'error');
        return;
      }
      toast('Space "' + state.name + '" created', 'success');
    }
    overlay.remove();
    ['_asoNext', '_asoBack', '_asoDismiss'].forEach(k => delete window[k]);
    try {
      loadRepoList();
    } catch (_) {}
    try {
      _refreshSpaceSwitcher();
    } catch (_) {}
    try {
      renderSettingsSpaces();
    } catch (_) {}
  }
  renderStep();
}
async function openEditSpaceDialog(name) {
  const spaces = await fetch('/api/spaces').then(r => r.json()).catch(() => ({}));
  const existing = spaces[name] || {};
  await openAddSpaceDialog({
    edit: true,
    name,
    description: existing.description || '',
    icon: existing.icon || 'layers',
    repos: Array.isArray(existing.repos) ? existing.repos : [],
    plugins: Array.isArray(existing.plugins) ? existing.plugins : []
  });
}
async function deleteSpace(name) {
  if (!name) return;
  const confirmed = await customConfirm('Delete Space', 'Delete space "' + name + '"? Repos inside it are not affected.', 'Delete');
  if (!confirmed) return;
  const res = await fetch('/api/spaces', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name
    })
  });
  if (!res.ok) {
    toast('Failed to delete space', 'error');
    return;
  }
  toast('Space removed', 'success');
  if (state.activeSpace === name) {
    state.activeSpace = '';
    try {
      localStorage.removeItem('symphonee-space');
    } catch (_) {}
  }
  try {
    loadRepoList();
  } catch (_) {}
  try {
    _refreshSpaceSwitcher();
  } catch (_) {}
  try {
    renderSettingsSpaces();
  } catch (_) {}
}
// Settings-modal Spaces section renderer.
async function renderSettingsSpaces() {
  const host = document.getElementById('settingsSpacesList');
  if (!host) return;
  let spaces = {};
  try {
    spaces = await fetch('/api/spaces').then(r => r.json());
  } catch (_) {}
  const names = Object.keys(spaces || {});
  if (!names.length) {
    host.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:10px 12px;background:var(--surface0);border:1px dashed var(--surface2);border-radius:var(--radius);">No spaces yet. Use "Add Space" to create one.</div>';
    return;
  }
  host.innerHTML = names.map(function (n) {
    const s = spaces[n] || {};
    const icon = s.icon || 'layers';
    const repoCount = (s.repos || []).length;
    const desc = s.description ? String(s.description) : '';
    return '<div class="settings-space-row" style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface0);border:1px solid var(--surface1);border-radius:var(--radius);margin-bottom:6px;">' + '<i data-lucide="' + esc(icon) + '" style="width:14px;height:14px;color:var(--accent);flex-shrink:0;"></i>' + '<div style="flex:1;min-width:0;">' + '<div style="font-size:12px;font-weight:600;color:var(--text);">' + esc(n) + '</div>' + '<div style="font-size:10px;color:var(--subtext0);">' + repoCount + ' repo' + (repoCount === 1 ? '' : 's') + (desc ? ' &middot; ' + esc(desc) : '') + '</div>' + '</div>' + '<button class="modal-btn" onclick="openEditSpaceDialog(' + JSON.stringify(n).replace(/"/g, '&quot;') + ')" style="padding:4px 10px;font-size:10px;">Edit</button>' + '<button class="modal-btn" onclick="deleteSpace(' + JSON.stringify(n).replace(/"/g, '&quot;') + ')" style="padding:4px 10px;font-size:10px;color:var(--red);">Delete</button>' + '</div>';
  }).join('');
  try {
    lucide.createIcons({
      nodes: [host]
    });
  } catch (_) {}
}

// ── Space / repo switcher (header chip) ─────────────────────────────────
async function _refreshSpaceSwitcher() {
  const spaceLabel = document.getElementById('spaceSwitcherLabel');
  const spaceChip = document.getElementById('spaceSwitcherChip');
  const repoChip = document.getElementById('repoChip');
  const repoLabel = document.getElementById('repoChipLabel');
  if (!spaceLabel || !spaceChip) return;
  let spaces = {},
    repos = {};
  try {
    [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
  } catch (_) {}
  // Space row: show active space name or fallback
  spaceLabel.textContent = state.activeSpace || 'All spaces';
  // Space icon: custom space icon or default layers
  let iconName = 'layers';
  if (state.activeSpace && spaces[state.activeSpace] && spaces[state.activeSpace].icon) iconName = spaces[state.activeSpace].icon;
  const iconEl = document.getElementById('spaceChipIcon');
  if (iconEl) {
    iconEl.setAttribute('data-lucide', iconName);
    try {
      lucide.createIcons({
        nodes: [spaceChip]
      });
    } catch (_) {}
  }
  // Repo row: show when a space is selected (to allow repo picking), when
  // a repo is active, or whenever any repos exist so the user can pick one
  // from "All spaces" without having to create a space first.
  // Always show the repo chip -- a brand-new user with zero repos needs a way
  // in. When nothing is added yet it reads "+ Add repo"; the picker it opens now
  // offers an "Add a repo" action even when the list is empty.
  const hasAnyRepo = Object.keys(repos).length > 0;
  if (repoChip) repoChip.style.display = '';
  if (repoLabel) repoLabel.textContent = state.activeRepo || (hasAnyRepo ? 'Select repo' : '+ Add repo');
  const menu = document.getElementById('spaceSwitcherMenu');
  if (menu && menu.classList.contains('open')) _renderSpaceSwitcherMenu(spaces, repos);
}
async function toggleSpaceSwitcher(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('spaceSwitcherMenu');
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', willOpen);
  if (willOpen) {
    const [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
    _renderSpaceSwitcherMenu(spaces, repos);
  }
}
function _renderSpaceSwitcherMenu(spaces, repos) {
  const menu = document.getElementById('spaceSwitcherMenu');
  if (!menu) return;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const spaceNames = Object.keys(spaces || {});
  const repoNames = Object.keys(repos || {});

  // Bucket repos by their parent space; everything else goes in "unassigned".
  const spaceRepos = {};
  const unassigned = [];
  for (const n of spaceNames) {
    const list = spaces[n] && Array.isArray(spaces[n].repos) ? spaces[n].repos : [];
    spaceRepos[n] = list.filter(r => repoNames.includes(r));
  }
  const inSomeSpace = new Set(Object.values(spaceRepos).flat());
  for (const r of repoNames) if (!inSomeSpace.has(r)) unassigned.push(r);

  // Render a single repo row (with a "REPO" type badge).
  const repoRow = (rName, nested) => {
    const active = rName === state.activeRepo ? ' active' : '';
    const pad = nested ? 'padding-left:26px;margin-left:10px;' : '';
    return '<div class="space-menu-item' + active + '" data-select-repo="' + esc(rName) + '" data-repo-name="' + esc(rName) + '" style="' + pad + '" title="Right-click to move to another space">' + '<i class="sm-icon" data-lucide="folder-git-2" style="width:13px;height:13px;"></i>' + '<div class="sm-label">' + esc(rName) + '</div>' + '<span style="font-size:9px;font-weight:600;color:var(--overlay1);letter-spacing:0.4px;flex-shrink:0;margin-left:6px;">REPO</span>' + '</div>';
  };

  // Render a space row (and its children indented beneath it).
  const spaceBlock = sName => {
    const sv = spaces[sName] || {};
    const active = sName === state.activeSpace ? ' active' : '';
    const icon = sv.icon || 'layers';
    const desc = sv.description || '';
    const kids = spaceRepos[sName] || [];
    const head = '<div class="space-menu-item' + active + '" data-select-space="' + esc(sName) + '">' + '<i class="sm-icon" data-lucide="' + esc(icon) + '" style="width:13px;height:13px;"></i>' + '<div class="sm-label">' + esc(sName) + (kids.length ? '<span style="color:var(--subtext0);font-weight:400;"> · ' + kids.length + '</span>' : '') + '</div>' + (desc ? '<span style="font-size:9px;color:var(--subtext0);">' + esc(desc) + '</span>' : '') + '<span style="font-size:9px;font-weight:600;color:var(--accent);letter-spacing:0.4px;flex-shrink:0;opacity:0.7;margin-left:6px;">SPACE</span>' + '<button class="sm-gear" data-manage-space="' + esc(sName) + '" title="Space settings"><i data-lucide="settings" style="width:11px;height:11px;"></i></button>' + '<button class="sm-del" data-del-space="' + esc(sName) + '" title="Delete space"><i data-lucide="x" style="width:11px;height:11px;"></i></button>' + '</div>';
    return head + kids.map(r => repoRow(r, true)).join('');
  };
  const noneItem = '<div class="space-menu-item' + (!state.activeSpace ? ' active' : '') + '" data-select-space="">' + '<i class="sm-icon" data-lucide="layers" style="width:13px;height:13px;"></i>' + '<div class="sm-label">All spaces</div></div>';
  const noRepoItem = '<div class="space-menu-item' + (!state.activeRepo ? ' active' : '') + '" data-select-repo="" data-repo-name="">' + '<i class="sm-icon" data-lucide="folder-x" style="width:13px;height:13px;"></i>' + '<div class="sm-label">No repo</div>' + '<span style="font-size:9px;font-weight:600;color:var(--overlay1);letter-spacing:0.4px;flex-shrink:0;margin-left:6px;">REPO</span>' + '</div>';
  const spacesBlockHtml = spaceNames.length ? '<div class="space-menu-section">Spaces</div>' + spaceNames.map(spaceBlock).join('') : '';

  // When no space is active, show ALL repos (including those in spaces).
  // When inside a space, repos are shown nested under the space block, so the
  // flat list stays empty. "No repo" always renders as the first item so the
  // user can clear the repo selection for work that isn't tied to a repository.
  let repoListHtml = '';
  if (!state.activeSpace && repoNames.length) repoListHtml = repoNames.map(r => repoRow(r, false)).join('');else if (!state.activeSpace && unassigned.length) repoListHtml = unassigned.map(r => repoRow(r, false)).join('');
  const allReposHtml = '<div class="space-menu-section">Repos</div>' + noRepoItem + repoListHtml;
  const body = '<div class="space-menu-body">' + noneItem + spacesBlockHtml + allReposHtml + (!spaceNames.length && !repoNames.length ? '<div class="space-menu-empty">No spaces or repos yet. Create one below.</div>' : '') + '</div>';
  const footer = '<div class="space-menu-footer">' + '<button onclick="(async()=>{document.getElementById(\'spaceSwitcherMenu\').classList.remove(\'open\');await openAddSpaceDialog();})()"><i data-lucide="layers" style="width:12px;height:12px;"></i>New space</button>' + '<button onclick="document.getElementById(\'spaceSwitcherMenu\').classList.remove(\'open\');openSettings(\'repos\');"><i data-lucide="plus" style="width:12px;height:12px;"></i>Add repo</button>' + (state.activeSpace ? '<button onclick="document.getElementById(\'spaceSwitcherMenu\').classList.remove(\'open\');openManageSpaceDialog(\'' + esc(state.activeSpace) + '\');"><i data-lucide="settings" style="width:12px;height:12px;"></i>Manage</button>' : '') + '</div>';
  menu.innerHTML = body + footer;
  menu.querySelectorAll('[data-select-space]').forEach(el => {
    el.addEventListener('click', ev => {
      if (ev.target.closest('.sm-del')) return;
      if (ev.target.closest('.sm-gear')) return;
      const name = el.dataset.selectSpace || '';
      selectSpace(name);
      menu.classList.remove('open');
    });
  });
  menu.querySelectorAll('.sm-gear').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const name = btn.dataset.manageSpace;
      if (!name) return;
      menu.classList.remove('open');
      openManageSpaceDialog(name);
    });
  });
  menu.querySelectorAll('[data-select-repo]').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.selectRepo;
      selectRepo(name);
      menu.classList.remove('open');
    });
    el.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      _openMoveRepoPopover(el.dataset.repoName, ev.clientX, ev.clientY, spaces);
    });
  });
  menu.querySelectorAll('.sm-del').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      deleteSpace(btn.dataset.delSpace);
    });
  });
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
}
// Close on outside click
document.addEventListener('click', e => {
  const menu = document.getElementById('spaceSwitcherMenu');
  const chip = document.getElementById('spaceSwitcherChip');
  if (!menu || !menu.classList.contains('open')) return;
  if (chip && chip.contains(e.target)) return;
  if (menu.contains(e.target)) return;
  menu.classList.remove('open');
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(_refreshSpaceSwitcher, 200);
});

// ── Repos & Spaces ──────────────────────────────────────────────────────
// Two independent active slots: activeSpace is the organizational container
// (Business, Personal, ...); activeRepo is the working repo within it. A
// repo can belong to at most one space; "No space" mode shows unassigned
// repos only.
state.activeSpace = localStorage.getItem('symphonee-space') || '';
state.activeRepo = localStorage.getItem('symphonee-repo') || '';
function _repoNamesForSpace(repos, spaces, spaceName) {
  const repoNames = Object.keys(repos || {});
  if (!spaceName) return repoNames;
  const members = spaces && spaces[spaceName] && Array.isArray(spaces[spaceName].repos) ? spaces[spaceName].repos : [];
  return members.filter(r => Object.prototype.hasOwnProperty.call(repos || {}, r));
}
async function loadRepoList() {
  try {
    const [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
    window._spacesCache = spaces || {};
    if (state.configData) {
      state.configData.Repos = repos || {};
      state.configData.Spaces = spaces || {};
    }
    const repoNames = Object.keys(repos);
    const spaceNames = Object.keys(spaces);

    // Legacy migration: before dual-state, activeRepo held either a space
    // name or a repo name. Split them into their proper slots - but ONLY
    // when the name is a space that isn't also a real repo. Without the
    // repoNames guard, a user whose repo and space share a name (e.g. both
    // "Symphonee") would get their repo silently wiped every refresh.
    if (state.activeRepo && spaces[state.activeRepo] && !repoNames.includes(state.activeRepo)) {
      state.activeSpace = state.activeRepo;
      state.activeRepo = '';
      localStorage.setItem('symphonee-space', state.activeSpace);
      localStorage.removeItem('symphonee-repo');
    }

    // Validate saved values still exist
    if (state.activeSpace && !spaces[state.activeSpace]) {
      state.activeSpace = '';
      localStorage.removeItem('symphonee-space');
    }
    if (state.activeRepo && !repoNames.includes(state.activeRepo)) {
      state.activeRepo = '';
      localStorage.removeItem('symphonee-repo');
    }
    const activeSpaceRepos = _repoNamesForSpace(repos, spaces, state.activeSpace);
    if (state.activeSpace && state.activeRepo && !activeSpaceRepos.includes(state.activeRepo)) {
      state.activeRepo = '';
      state.filesCurrentRepo = '';
      localStorage.removeItem('symphonee-repo');
    }
    if (state.activeSpace && !state.activeRepo && activeSpaceRepos.length === 1) {
      state.activeRepo = activeSpaceRepos[0];
      state.filesCurrentRepo = state.activeRepo;
      localStorage.setItem('symphonee-repo', state.activeRepo);
    }

    // If an activeRepo is set and belongs to a space, snap to that space on
    // very first boot only (i.e. when the user has no stored space preference
    // at all). After that, spaces and repos are fully independent - an
    // explicit "All spaces" choice (stored as "") must survive reloads.
    if (state.activeRepo && !loadRepoList._snappedOwnerOnce && localStorage.getItem('symphonee-space') === null) {
      const owner = _findSpaceForRepo(spaces, state.activeRepo);
      if (owner && owner !== state.activeSpace) {
        state.activeSpace = owner;
        localStorage.setItem('symphonee-space', state.activeSpace);
      }
    }
    loadRepoList._snappedOwnerOnce = true;
    if (state.activeRepo) state.filesCurrentRepo = state.activeRepo;
    if (!state.activeRepo && state.filesCurrentRepo) state.filesCurrentRepo = '';
    try {
      populateFilesRepoSelect();
    } catch (_) {}

    // Keep the header chip in sync.
    try {
      _refreshSpaceSwitcher();
    } catch (_) {}
    lucide.createIcons();

    // On startup, if we have a saved repo, fetch+pull and load git status
    if (state.activeRepo && !loadRepoList._initialized) {
      loadRepoList._initialized = true;
      fetchAndPullOnStartup(state.activeRepo);
      loadGitStatusForDiffTab(state.activeRepo);
    }
    // Hide git actions when no repo selected (spaces alone have no git).
    const gitActions = document.getElementById('sidebarGitActions');
    if (gitActions) gitActions.style.display = state.activeRepo ? '' : 'none';
    pushUiContext();
    loadTerminalScripts();
  } catch (_) {}
}

// Find which space (if any) contains a given repo name.
function _findSpaceForRepo(spaces, repoName) {
  if (!spaces || !repoName) return null;
  for (const [name, s] of Object.entries(spaces)) {
    if (s && Array.isArray(s.repos) && s.repos.includes(repoName)) return name;
  }
  return null;
}
async function fetchRepoSidebarBranch(repoName) {
  try {
    const res = await fetch(`/api/git/branches?repo=${encodeURIComponent(repoName)}`);
    const data = await res.json();
    const el = document.getElementById('repoSidebarBranch');
    if (el && data.current) el.textContent = data.current;
  } catch (_) {}
}
async function fetchAndPullOnStartup(repoName) {
  try {
    // Only pull if the working tree is clean (don't risk conflicts with uncommitted changes)
    const statusRes = await fetch(`/api/git/status?repo=${encodeURIComponent(repoName)}`);
    const statusData = await statusRes.json();
    if (statusData.files && statusData.files.length > 0) return; // dirty - skip pull

    const res = await fetch('/api/git/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo: repoName
      })
    });
    const data = await res.json();
    if (data.ok && data.message && data.message !== 'Already up to date.') {
      toast('Pulled latest changes for ' + repoName, 'info');
    }
    // Refresh sidebar branch and diff tab after pull
    fetchRepoSidebarBranch(repoName);
    loadGitStatusForDiffTab(repoName);
  } catch (_) {}
}
async function loadGitStatusForDiffTab(repoName) {
  try {
    const res = await fetch(`/api/git/status?repo=${encodeURIComponent(repoName)}`);
    const git = await res.json();
    // Update sidebar branch display
    if (!git.error && git.branch) {
      const el = document.getElementById('repoSidebarBranch');
      if (el) el.textContent = git.branch;
      // Keep the header branch chip in sync when the branch changes outside the UI
      // (e.g. a terminal checkout). Only touch the chip for the active repo.
      if (repoName === state.activeRepo) {
        const chipLabel = document.getElementById('branchChipLabel');
        if (chipLabel && chipLabel.textContent !== git.branch) _setBranchChip(git.branch);
      }
    }
    if (!git.error && git.files && git.files.length > 0) {
      document.getElementById('diffviewTabBtn').style.display = '';
      populateDiffTabWithChanges(git.files, repoName);
    } else {
      // Hide diff tab if no changes (unless viewing a commit diff)
      if (!state.diffViewCommit || state.diffViewCommit.hash === 'working') {
        document.getElementById('diffviewTabBtn').style.display = 'none';
      }
    }
  } catch (_) {}
}

// Poll git status every 10s to auto-show/hide the diff tab
state._gitPollTimer = null;
function startGitStatusPolling() {
  if (state._gitPollTimer) clearInterval(state._gitPollTimer);
  state._gitPollTimer = setInterval(() => {
    const repo = state.activeRepo || state.filesCurrentRepo;
    if (repo) loadGitStatusForDiffTab(repo);
  }, 10000);
}
startGitStatusPolling();
function selectRepo(name) {
  state.activeRepo = name;
  state.filesCurrentRepo = name;

  // Spaces and repos are independent selections. Picking a repo from "All
  // spaces" (or from a different space) must NOT auto-switch the space --
  // that forced users out of All-spaces mode whenever they chose a repo
  // that happened to belong to a space.

  try {
    _refreshSpaceSwitcher();
  } catch (_) {}
  try {
    refreshBranchChip();
  } catch (_) {}
  const gitActions = document.getElementById('sidebarGitActions');
  if (!name) {
    localStorage.removeItem('symphonee-repo');
    if (gitActions) gitActions.style.display = 'none';
    const scriptsBar = document.getElementById('filesScriptsBar');
    if (scriptsBar) scriptsBar.style.display = 'none';
    const termBar = document.getElementById('termScriptsBar');
    if (termBar) termBar.style.display = 'none';
  } else {
    localStorage.setItem('symphonee-repo', name);
    if (gitActions) gitActions.style.display = '';
  }
  loadRepoList();

  // Sync files tab repo selector
  const select = document.getElementById('filesRepoSelect');
  if (select) select.value = name;

  // Sync work item tab "Start Working" repo selector
  const startWorkSelect = document.getElementById('startWorkRepo');
  if (startWorkSelect && name) startWorkSelect.value = name;
  if (name) {
    loadFileTree('');
    loadGitLogPanel();
    loadProjectScripts();
  }
  loadTerminalScripts();

  // Sync PR tab repo selector and reload PRs if on that tab
  const prSelect = document.getElementById('prsRepoSelect');
  if (prSelect) {
    prSelect.value = name;
    state.prsCurrentRepo = name;
  }
  if (name && document.getElementById('panel-prs')?.classList.contains('active')) {
    loadPRs();
  }
  pushUiContext();
  notifyPluginIframes('repoChanged', {
    repo: name || null
  });
  try {
    refreshNotesForSpace();
  } catch (_) {}
  try {
    applyPluginSpaceFilter();
  } catch (_) {}
}

// Small popover anchored at (x, y) for moving a repo into (or out of) a space.
// Writes via /api/spaces/attach-repo which enforces single-space membership.
function _openMoveRepoPopover(repoName, x, y, spaces) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  document.getElementById('moveRepoPopover')?.remove();
  const currentOwner = _findSpaceForRepo(spaces, repoName);
  const pop = document.createElement('div');
  pop.id = 'moveRepoPopover';
  pop.style.cssText = 'position:fixed;z-index:9500;min-width:200px;max-height:300px;overflow:auto;background:var(--surface0);border:1px solid var(--surface2);border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,0.5);padding:4px;font:12px var(--font-ui);';
  const spaceNames = Object.keys(spaces || {});
  const header = '<div style="padding:6px 10px;color:var(--subtext0);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;">Move ' + esc(repoName) + ' to</div>';
  const items = spaceNames.map(n => {
    const isCurrent = n === currentOwner;
    return '<div class="mrp-item" data-target="' + esc(n) + '" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:4px;cursor:pointer;' + (isCurrent ? 'color:var(--accent);' : '') + '" onmouseover="this.style.background=\'var(--surface1)\'" onmouseout="this.style.background=\'\'">' + '<i data-lucide="' + esc(spaces[n] && spaces[n].icon || 'layers') + '" style="width:13px;height:13px;"></i>' + '<span style="flex:1;">' + esc(n) + '</span>' + (isCurrent ? '<i data-lucide="check" style="width:12px;height:12px;"></i>' : '') + '</div>';
  }).join('');
  const unassign = currentOwner ? '<div style="border-top:1px solid var(--surface1);margin:4px 0;"></div>' + '<div class="mrp-item" data-target="" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:4px;cursor:pointer;color:var(--subtext0);" onmouseover="this.style.background=\'var(--surface1)\'" onmouseout="this.style.background=\'\'">' + '<i data-lucide="minus-circle" style="width:13px;height:13px;"></i>' + '<span>Unassign (remove from ' + esc(currentOwner) + ')</span>' + '</div>' : '';
  pop.innerHTML = header + items + unassign;
  document.body.appendChild(pop);
  // Keep inside viewport
  const rect = pop.getBoundingClientRect();
  const vw = window.innerWidth,
    vh = window.innerHeight;
  pop.style.left = Math.min(x, vw - rect.width - 8) + 'px';
  pop.style.top = Math.min(y, vh - rect.height - 8) + 'px';
  try {
    lucide.createIcons({
      nodes: [pop]
    });
  } catch (_) {}
  pop.querySelectorAll('.mrp-item').forEach(row => {
    row.addEventListener('click', async () => {
      const target = row.dataset.target;
      try {
        const r = await fetch('/api/spaces/attach-repo', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            space: target || currentOwner || '',
            repo: repoName,
            attach: target !== '' // empty target = detach from current
          })
        });
        if (!r.ok) throw new Error(await r.text().catch(() => 'HTTP ' + r.status));
        pop.remove();
        toast(target ? 'Moved ' + repoName + ' to ' + target : 'Unassigned ' + repoName, 'success');
        // Refresh the switcher menu if still open, and the sidebar list.
        try {
          _refreshSpaceSwitcher();
        } catch (_) {}
        try {
          loadRepoList();
        } catch (_) {}
      } catch (err) {
        toast('Move failed: ' + (err.message || err), 'error');
      }
    });
  });

  // Close on outside click / escape.
  const closer = ev => {
    if (!pop.contains(ev.target)) {
      pop.remove();
      document.removeEventListener('mousedown', closer);
      document.removeEventListener('keydown', keyCloser);
    }
  };
  const keyCloser = ev => {
    if (ev.key === 'Escape') {
      pop.remove();
      document.removeEventListener('mousedown', closer);
      document.removeEventListener('keydown', keyCloser);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closer), 0);
  document.addEventListener('keydown', keyCloser);
}

// Manage a space: edit description/icon, pick which repos belong to it, and
// choose which plugins are surfaced while this space is active. Opens over the
// main UI and writes changes through /api/spaces and /api/spaces/*.
async function openManageSpaceDialog(name) {
  if (!name) return;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let spaces = {},
    repos = {},
    plugins = [];
  try {
    [spaces, repos, plugins] = await Promise.all([fetch('/api/spaces').then(r => r.json()).catch(() => ({})), fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/plugins').then(r => r.json()).catch(() => [])]);
  } catch (_) {}
  const s = spaces[name] || {};
  const repoNames = Object.keys(repos);
  const pluginList = (Array.isArray(plugins) ? plugins : []).filter(p => p && !isCoreSpacePluginId(p.id));
  const toggle = (dataAttr, val, checked) => '<label class="ms-toggle"><input type="checkbox" ' + dataAttr + '="' + esc(val) + '"' + (checked ? ' checked' : '') + '><span class="ms-toggle-track"></span></label>';
  const reposHtml = repoNames.length ? repoNames.map(r => {
    const on = (s.repos || []).includes(r);
    let owner = null;
    for (const [n, other] of Object.entries(spaces)) {
      if (n === name) continue;
      if (other && Array.isArray(other.repos) && other.repos.includes(r)) {
        owner = n;
        break;
      }
    }
    return '<div class="ms-row">' + toggle('data-ms-repo', r, on) + '<i data-lucide="folder-git-2" style="width:13px;height:13px;color:var(--subtext0);flex-shrink:0;"></i>' + '<span class="ms-row-label">' + esc(r) + '</span>' + (owner ? '<span class="ms-row-sub">in ' + esc(owner) + '</span>' : '') + '</div>';
  }).join('') : '<div style="color:var(--subtext0);font-size:11px;padding:10px 2px;">No repos configured.</div>';
  const pluginsHtml = pluginList.length ? pluginList.map(p => {
    const on = (s.plugins || []).includes(p.id);
    return '<div class="ms-row">' + toggle('data-ms-plugin', p.id, on) + '<i data-lucide="' + esc(p.icon || 'puzzle') + '" style="width:13px;height:13px;color:var(--subtext0);flex-shrink:0;"></i>' + '<span class="ms-row-label">' + esc(p.name || p.id) + '</span>' + '</div>';
  }).join('') : '<div style="color:var(--subtext0);font-size:11px;padding:10px 2px;">No plugins installed.</div>';
  let overlay = document.getElementById('manageSpaceOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'manageSpaceOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:4000;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML = '<div class="ms-dialog">' + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-shrink:0;">' + '<i data-lucide="' + esc(s.icon || 'layers') + '" style="width:18px;height:18px;color:var(--accent);"></i>' + '<strong style="font-size:14px;">' + esc(name) + '</strong>' + '<div style="flex:1;"></div>' + '<button onclick="document.getElementById(\'manageSpaceOverlay\').remove()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:4px;border-radius:4px;" onmouseover="this.style.color=\'var(--text)\'" onmouseout="this.style.color=\'var(--subtext0)\'"><i data-lucide="x" style="width:14px;height:14px;"></i></button>' + '</div>' + '<div class="ms-tabs">' + '<button class="ms-tab active" data-ms-tab="repos" onclick="_msSwitchTab(this,\'repos\')">' + '<i data-lucide="folder-git-2" style="width:12px;height:12px;"></i>Repos' + '</button>' + '<button class="ms-tab" data-ms-tab="plugins" onclick="_msSwitchTab(this,\'plugins\')">' + '<i data-lucide="puzzle" style="width:12px;height:12px;"></i>Plugins' + '</button>' + '</div>' + '<div class="ms-tab-panel active" id="msTabRepos">' + '<div class="ms-list">' + reposHtml + '</div>' + '<div class="ms-tab-hint">A repo can only belong to one space at a time.</div>' + '</div>' + '<div class="ms-tab-panel" id="msTabPlugins">' + '<div class="ms-list">' + pluginsHtml + '</div>' + '<div class="ms-tab-hint">Leave all off to surface every installed plugin while this space is active. Browser tools remain available even when not listed here.</div>' + '</div>' + '<div style="display:flex;gap:8px;margin-top:16px;flex-shrink:0;">' + '<div style="flex:1;"></div>' + '<button class="sy-btn sy-btn-secondary" onclick="document.getElementById(\'manageSpaceOverlay\').remove()">Cancel</button>' + '<button class="sy-btn sy-btn-primary" onclick="_saveManageSpace(\'' + esc(name) + '\')">Save</button>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  try {
    lucide.createIcons({
      nodes: [overlay]
    });
  } catch (_) {}

  // Wire toggle rows: clicking the row fires the hidden checkbox
  overlay.querySelectorAll('.ms-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.ms-toggle')) return;
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = !cb.checked;
    });
  });
}
function _msSwitchTab(btn, tab) {
  const overlay = document.getElementById('manageSpaceOverlay');
  if (!overlay) return;
  overlay.querySelectorAll('.ms-tab').forEach(t => t.classList.toggle('active', t.dataset.msTab === tab));
  overlay.querySelectorAll('.ms-tab-panel').forEach(p => p.classList.toggle('active', p.id === (tab === 'repos' ? 'msTabRepos' : 'msTabPlugins')));
}
async function _saveManageSpace(name) {
  const overlay = document.getElementById('manageSpaceOverlay');
  if (!overlay) return;
  const repos = [...overlay.querySelectorAll('[data-ms-repo]:checked')].map(el => el.dataset.msRepo);
  const plugins = [...overlay.querySelectorAll('[data-ms-plugin]:checked')].map(el => el.dataset.msPlugin);
  try {
    const r = await fetch('/api/spaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        repos,
        plugins
      })
    });
    if (!r.ok) throw new Error(await r.text().catch(() => 'HTTP ' + r.status));
    toast('Space updated', 'success');
    overlay.remove();
    loadRepoList();
    try {
      _refreshSpaceSwitcher();
    } catch (_) {}
    try {
      applyPluginSpaceFilter();
    } catch (_) {}
  } catch (err) {
    toast('Save failed: ' + (err.message || err), 'error');
  }
}

// Placeholders filled in by later tasks (notes/plugin scoping). Defined here
// so selectSpace/selectRepo can call them without throwing before they're
// fully wired up.
function refreshNotesForSpace() {
  // Close whatever note was open - it may belong to a different space now.
  try {
    state.currentNote = null;
    const title = document.getElementById('noteTitle');
    if (title) title.textContent = 'No note selected';
    const editor = document.getElementById('noteEditor');
    if (editor) editor.style.display = 'none';
    const preview = document.getElementById('notePreview');
    if (preview) preview.style.display = 'none';
    const empty = document.getElementById('noteEmpty');
    if (empty) empty.style.display = '';
  } catch (_) {}
  // Update the sidebar label so the user knows which space's notebook they're in.
  try {
    const lbl = document.getElementById('notesSpaceLabel');
    if (lbl) lbl.textContent = state.activeSpace ? 'Notes · ' + state.activeSpace : 'Notes';
  } catch (_) {}
  try {
    if (typeof loadNotesList === 'function') loadNotesList();
  } catch (_) {}
}
// Hide or show UI elements contributed by each plugin based on the active
// space's preset. A space with an empty plugins[] list shows everything (no
// filter). "No space" also shows everything. Elements opt in by carrying a
// data-plugin-id attribute; this walks the document and toggles their
// visibility via a shared CSS class.
async function applyPluginSpaceFilter() {
  let allowed = null; // null = no filter (show all)
  // Always refresh the shared spaces cache so other UI (e.g. the '+' tab menu)
  // can consult it synchronously.
  try {
    window._spacesCache = (await fetch('/api/spaces').then(r => r.json()).catch(() => ({}))) || {};
  } catch (_) {
    window._spacesCache = window._spacesCache || {};
  }
  if (state.activeSpace) {
    const spaces = window._spacesCache;
    const preset = (spaces[state.activeSpace] && Array.isArray(spaces[state.activeSpace].plugins) ? spaces[state.activeSpace].plugins : []).filter(id => !isCoreSpacePluginId(id));
    if (preset.length) {
      allowed = new Set(preset);
      CORE_SPACE_PLUGIN_IDS.forEach(id => allowed.add(id));
    }
  }
  document.querySelectorAll('[data-plugin-id]').forEach(el => {
    const id = el.getAttribute('data-plugin-id');
    const hide = allowed && !allowed.has(id);
    el.classList.toggle('plugin-space-hidden', !!hide);
  });
  // Filtering the currently-active tab into hiding would strand the user on a
  // blank page - fall back to terminal if that happens.
  const active = document.querySelector('.tab-btn.active');
  if (active && active.classList.contains('plugin-space-hidden')) {
    try {
      switchTab('terminal');
    } catch (_) {}
  }
  // Re-evaluate section title visibility now that buttons may have been hidden.
  try {
    reconcilePluginShellSurfaces();
  } catch (_) {}
}

// Switch the active space. If the new space has a single repo, auto-select
// it; otherwise clear activeRepo so the user can pick one explicitly.
async function selectSpace(name) {
  state.activeSpace = name || '';
  // Always store the choice (even "" for "All spaces") so the preference
  // survives reloads. A missing key means "never chose", which triggers the
  // first-boot snap-to-owner-space; "" means the user explicitly opted out.
  localStorage.setItem('symphonee-space', state.activeSpace);

  // If the currently-active repo doesn't belong to the new space, clear it.
  try {
    const spaces = await fetch('/api/spaces').then(r => r.json()).catch(() => ({}));
    const members = spaces[state.activeSpace] && Array.isArray(spaces[state.activeSpace].repos) ? spaces[state.activeSpace].repos : [];
    if (state.activeRepo && !members.includes(state.activeRepo)) {
      // Clear the repo when leaving its space (unless going to "No space",
      // in which case unassigned repos are still valid).
      if (state.activeSpace) {
        state.activeRepo = '';
        state.filesCurrentRepo = '';
        localStorage.removeItem('symphonee-repo');
      }
    }
    // Auto-select if the space has exactly one repo and none is active.
    if (state.activeSpace && !state.activeRepo && members.length === 1) {
      selectRepo(members[0]);
      return;
    }
  } catch (_) {}
  try {
    _refreshSpaceSwitcher();
  } catch (_) {}
  loadRepoList();
  pushUiContext();
  try {
    refreshNotesForSpace();
  } catch (_) {}
  try {
    applyPluginSpaceFilter();
  } catch (_) {}
  // Reset orchestrator scope default for the new space and re-fetch.
  try {
    const el = document.getElementById('orchScopeFilter');
    if (el) delete el.dataset.userTouched;
    syncOrchScopeFilter();
    if (typeof orchRefreshTasks === 'function') orchRefreshTasks();
  } catch (_) {}
  notifyPluginIframes('spaceChanged', {
    space: state.activeSpace || null
  });
}// ── Create Work Item Modal ──────────────────────────────────────────────
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
}// ── Utilities ───────────────────────────────────────────────────────────
// ── Full-screen loading overlay ──────────────────────────────────────────
const _loadingQuotes = [{
  text: 'First, solve the problem. Then, write the code.',
  author: 'John Johnson'
}, {
  text: 'Simplicity is the soul of efficiency.',
  author: 'Austin Freeman'
}, {
  text: 'Code is like humor. When you have to explain it, it\'s bad.',
  author: 'Cory House'
}, {
  text: 'Make it work, make it right, make it fast.',
  author: 'Kent Beck'
}, {
  text: 'The best error message is the one that never shows up.',
  author: 'Thomas Fuchs'
}, {
  text: 'Talk is cheap. Show me the code.',
  author: 'Linus Torvalds'
}, {
  text: 'Any fool can write code that a computer can understand. Good programmers write code that humans can understand.',
  author: 'Martin Fowler'
}, {
  text: 'Measuring programming progress by lines of code is like measuring aircraft building progress by weight.',
  author: 'Bill Gates'
}, {
  text: 'Perfection is achieved not when there is nothing more to add, but when there is nothing left to take away.',
  author: 'Antoine de Saint-Exupery'
}, {
  text: 'The most disastrous thing that you can ever learn is your first programming language.',
  author: 'Alan Kay'
}, {
  text: 'Programming is the art of telling another human what one wants the computer to do.',
  author: 'Donald Knuth'
}, {
  text: 'It works on my machine.',
  author: 'Every Developer'
}];
state._loadingTimer = null;
state._quoteTimer = null;
function showLoading(text) {
  const el = document.getElementById('loadingOverlay');
  document.getElementById('loadingLabel').textContent = text || 'Loading';
  el.classList.add('visible');
  // Show a random quote with fade-in
  _showRandomQuote();
  clearTimeout(state._loadingTimer);
  state._loadingTimer = setTimeout(hideLoading, 8000);
}
function _showRandomQuote() {
  // In boot ("splash") mode these are plain LLM facts shown big, so render them
  // unquoted with no author. The manual-refresh mode keeps the "quote" — author
  // styling.
  const boot = document.getElementById('loadingOverlay').classList.contains('boot');
  const fmt = s => boot ? s : '"' + s + '"';
  const q = _loadingQuotes[Math.floor(Math.random() * _loadingQuotes.length)];
  const quoteEl = document.getElementById('loadingQuote');
  const textEl = document.getElementById('loadingQuoteText');
  const authorEl = document.getElementById('loadingQuoteAuthor');
  quoteEl.classList.remove('visible');
  setTimeout(() => {
    textEl.textContent = fmt(q.text);
    authorEl.textContent = q.author ? '— ' + q.author : '';
    quoteEl.classList.add('visible');
  }, 150);
  clearInterval(state._quoteTimer);
  state._quoteTimer = setInterval(() => {
    const next = _loadingQuotes[Math.floor(Math.random() * _loadingQuotes.length)];
    quoteEl.classList.remove('visible');
    setTimeout(() => {
      textEl.textContent = fmt(next.text);
      authorEl.textContent = next.author ? '— ' + next.author : '';
      quoteEl.classList.add('visible');
    }, 400);
  }, 4000);
}
function hideLoading() {
  clearTimeout(state._loadingTimer);
  clearInterval(state._quoteTimer);
  const quoteEl = document.getElementById('loadingQuote');
  quoteEl.classList.remove('visible');
  document.getElementById('loadingOverlay').classList.remove('visible');
}

// ── Boot loading overlay ────────────────────────────────────────────────────
// Covers the initial dashboard render with cycling Mind-generated quotes
// (continuous with splash.html). It stays up until the heavy startup work the
// user actually waits for is DONE -- the Mind incremental refresh, which also
// re-ingests the managed repos, signalled by the 'mind-startup-refresh' WS
// message -- not merely until the page's own assets finished loading. The few
// extra seconds are intentional so the dashboard is fully populated on reveal.
state._bootOverlayDone = false;
state._bootPageLoaded = false; // window 'load' fired (dashboard assets in)
state._bootMindReady = false; // mind-startup-refresh reached a terminal phase
state._bootMinRevealAt = 0; // earliest time we allow the reveal
function hideBootOverlay() {
  if (state._bootOverlayDone) return;
  state._bootOverlayDone = true;
  hideLoading();
  // Drop the boot (splash) styling once it has faded out, so a later manual
  // showLoading() (refresh/import) uses the normal compact overlay, not the
  // big centered-logo splash.
  const ov = document.getElementById('loadingOverlay');
  if (ov) setTimeout(() => ov.classList.remove('boot'), 700);
}
// Reveal the dashboard only when BOTH the page assets are loaded AND the Mind /
// repos startup refresh is done -- and never before the minimum dwell. The hard
// cap in _initBootLoading guarantees the overlay can't get stuck if a readiness
// signal never arrives.
function _maybeRevealDashboard() {
  if (state._bootOverlayDone || !state._bootPageLoaded || !state._bootMindReady) return;
  setTimeout(hideBootOverlay, Math.max(0, state._bootMinRevealAt - Date.now()));
}
// Poll the server's authoritative startup-readiness flag. It flips true only
// once the Mind refresh has run AND the graph build lock is free (so a 'skipped'
// refresh -- where the watcher's build is the one actually running -- still
// waits for that build). Polling (not a WS event) is immune to a completion
// that fires before this page connected, and to the early 'skipped' signal that
// previously released the overlay mid-build.
async function _pollStartupReady() {
  const deadline = Date.now() + 24000;
  for (;;) {
    try {
      const r = await fetch('/api/startup/status', {
        cache: 'no-store'
      });
      if (r.ok) {
        const d = await r.json();
        if (d && d.ready) break;
      }
    } catch (_) {/* keep polling */}
    if (Date.now() > deadline) break;
    await new Promise(res => setTimeout(res, 400));
  }
  state._bootMindReady = true;
  _maybeRevealDashboard();
}
async function _initBootLoading() {
  const ov = document.getElementById('loadingOverlay');
  if (!ov) return;
  ov.classList.add('boot');
  ov.classList.add('visible');
  // Show a quote IMMEDIATELY so there is no empty gap after the splash->dashboard
  // navigation (the old code awaited the quotes fetch before the first quote,
  // which is why a quote appeared, vanished, then a second one rolled in). The
  // Mind quotes are swapped into the SAME array below, so the next cycle picks
  // them up seamlessly with no reset.
  _showRandomQuote();
  const MIN_REVEAL = 2500;
  state._bootMinRevealAt = Date.now() + MIN_REVEAL;
  // Hard safety cap so the overlay can never get stuck even if a readiness
  // signal never arrives (headless server, missed broadcast, very slow build).
  setTimeout(hideBootOverlay, 25000);
  // Gate 1: page assets loaded.
  const onLoaded = () => {
    state._bootPageLoaded = true;
    _maybeRevealDashboard();
  };
  if (document.readyState === 'complete') onLoaded();else window.addEventListener('load', onLoaded, {
    once: true
  });
  // Gate 2: server reports startup work settled (Mind refreshed + repos ingested).
  _pollStartupReady();
  // Swap in personal Mind quotes (best-effort) without resetting the cycle.
  try {
    const r = await fetch('/api/splash/quotes');
    if (r.ok) {
      const d = await r.json();
      if (d && Array.isArray(d.quotes) && d.quotes.length) {
        _loadingQuotes.length = 0;
        for (const q of d.quotes) _loadingQuotes.push({
          text: q.text,
          author: q.author || 'Symphonee'
        });
      }
    }
  } catch (_) {}
}
_initBootLoading();
async function refreshAll() {
  showLoading('Refreshing');
  const minWait = new Promise(r => setTimeout(r, 4000));
  try {
    await loadWorkItems(true);
    loadVelocity();
    // Refresh the currently open work item detail if viewing one
    if (state.currentWiDetail) viewWorkItem(state.currentWiDetail.id);
    // Refresh the currently open PR detail if viewing one
    if (state.prsCurrentNumber) viewPR(state.prsCurrentNumber);
  } catch (_) {}
  await minWait;
  hideLoading();
}
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Onboarding Wizard ───────────────────────────────────────────────────
state._obStep = 0;
state._obData = {
  displayName: '',
  org: '',
  project: '',
  pat: '',
  team: '',
  ghPat: '',
  defaultCli: 'claude',
  repos: {},
  theme: 'industrial-blue'
};
state._obAiStatus = {};
function obPickTheme(themeId) {
  state._obData.theme = themeId;
  applyBuiltinTheme(themeId);
  document.querySelectorAll('.ob-theme-card').forEach(el => {
    const isSel = el.dataset.themeId === themeId;
    el.classList.toggle('selected', isSel);
    el.style.borderColor = isSel ? 'var(--accent)' : 'var(--surface2)';
  });
}

// Short usage guides shown on the final onboarding screen. Thumbnails are
// placeholders (icon tiles) until real clips are added under public/guides/.
const OB_GUIDE_VIDEOS = [{
  icon: 'terminal',
  title: 'Launch an AI',
  desc: 'Pick a CLI and start talking in the terminal.'
}, {
  icon: 'search',
  title: 'Command palette',
  desc: 'Jump anywhere, run actions, or ask a quick question.'
}, {
  icon: 'git-compare',
  title: 'Review & commit',
  desc: 'See diffs and commit with AI-written messages.'
}, {
  icon: 'brain',
  title: 'Your Mind',
  desc: 'Symphonee remembers context across sessions and CLIs.'
}, {
  icon: 'package',
  title: 'Share knowledge (KIT)',
  desc: 'Export a topic and hand it to anyone.'
}, {
  icon: 'puzzle',
  title: 'Plugins',
  desc: 'Add integrations per project from Settings.'
}];
state._obNeedsRestart = false; // set when a step did something that needs a relaunch
state._obBrainReady = false;   // gates the Local AI step: Ollama + both models installed
// Required local-AI setup. Walks the user through: install Ollama (gated) ->
// install the triage (~1GB) + reasoning (~16GB) models (each with live progress).
// Sets state._obBrainReady when fully set up, which the step's validate() checks.
async function obCheckBrain() {
  const status = document.getElementById('obBrainStatus');
  const actions = document.getElementById('obBrainActions');
  if (!status) return;
  let d = {};
  try { d = await fetch('/api/symphonee/setup/check').then(r => r.json()); }
  catch (_) { status.innerHTML = 'Could not check local AI status. Make sure the app is running, then re-check.'; if (actions) actions.innerHTML = '<button class="onboarding-btn onboarding-btn-secondary" onclick="obCheckBrain()">Re-check</button>'; return; }

  const triage = d.triageModel || 'qwen2.5:1.5b';
  const reasoning = d.reasoningModel || 'gemma4:26b';
  const triageOk = !!d.triageModelInstalled;
  const reasonOk = !!d.reasoningModelInstalled;
  state._obBrainReady = !!(d.ollamaInstalled && d.ollamaRunning && triageOk && reasonOk);

  if (!d.ollamaInstalled) {
    status.innerHTML = '<b>Step 1 of 2: Install Ollama.</b><br>Symphonee\'s brain runs locally on Ollama - private, no API keys, no quota. Install it (free, a few minutes), then re-check.';
    actions.innerHTML = '<button class="onboarding-btn onboarding-btn-primary" onclick="openExternal(\'https://ollama.com/download\')">Get Ollama</button>'
      + '<button class="onboarding-btn onboarding-btn-secondary" onclick="obCheckBrain()">I installed it - re-check</button>';
  } else if (!d.ollamaRunning) {
    status.innerHTML = 'Ollama is installed but not running. Start Ollama, then re-check.';
    actions.innerHTML = '<button class="onboarding-btn onboarding-btn-primary" onclick="obCheckBrain()">Re-check</button>';
  } else if (state._obBrainReady) {
    status.innerHTML = '<span style="color:var(--green);font-weight:600;">Local AI is fully set up.</span><br>Both models are installed - the Mind, instant local answers, and local automation are ready. Click Next.';
    actions.innerHTML = '';
  } else {
    status.innerHTML = '<b>Step 2 of 2: Install the brain models.</b><br>Two one-time downloads: the small <b>triage</b> model and the larger <b>reasoning</b> model. Both are required.';
    actions.innerHTML =
      (triageOk
        ? '<div class="ob-model-row ob-model-done"><i data-lucide="check-circle"></i> Triage model (' + esc(triage) + ') installed</div>'
        : '<button class="onboarding-btn onboarding-btn-primary ob-model-btn" data-ob-model="' + esc(triage) + '" onclick="obInstallModel(this)">Install triage model (' + esc(triage) + ', ~1 GB)</button>')
      + (reasonOk
        ? '<div class="ob-model-row ob-model-done"><i data-lucide="check-circle"></i> Reasoning model (' + esc(reasoning) + ') installed</div>'
        : '<button class="onboarding-btn onboarding-btn-primary ob-model-btn" data-ob-model="' + esc(reasoning) + '" onclick="obInstallModel(this)">Install reasoning model (' + esc(reasoning) + ', ~16 GB)</button>');
  }
  try { lucide.createIcons(); } catch (_) {}
}
async function obInstallModel(btn) {
  const model = btn.getAttribute('data-ob-model');
  if (!model) return;
  btn.disabled = true;
  btn.textContent = 'Starting ' + model + '...';
  state._obNeedsRestart = true;
  const onPull = (e) => {
    const p = e.detail || {};
    if (p.kind !== 'ollama-pull' || (p.model && p.model !== model)) return;
    if (p.status === 'success') { window.removeEventListener('symphonee-mind-update', onPull); obCheckBrain(); return; }
    if (p.status === 'error') { window.removeEventListener('symphonee-mind-update', onPull); btn.disabled = false; btn.textContent = 'Download failed - retry ' + model; return; }
    const gb = (n) => Math.round((n || 0) / 1e9 * 10) / 10;
    btn.textContent = (p.status || 'downloading') + (p.total ? ' - ' + gb(p.completed) + ' / ' + gb(p.total) + ' GB' : '');
  };
  window.addEventListener('symphonee-mind-update', onPull);
  try { await fetch('/api/symphonee/setup/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }); } catch (_) {}
}
const OB_STEPS = [
// 0: Display name
() => ({
  title: 'What should we call you?',
  subtitle: 'This will be used as your display name across Symphonee.',
  html: `<div class="onboarding-field"><label>Your Name</label><input id="obName" type="text" placeholder="e.g. Jane Doe" value="${esc(state._obData.displayName)}" oninput="_obData.displayName=this.value"></div>`,
  validate: () => !!state._obData.displayName.trim()
}),
// 1: Welcome
() => ({
  title: `Welcome, ${esc(state._obData.displayName.split(' ')[0])}!`,
  subtitle: "Let's get Symphonee set up. We'll install the local AI it runs on, then you can add AI tools, plugins, and your repos. Almost everything here can be changed later from Settings.",
  html: `<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
      <div class="onboarding-overview-item"><div class="onboarding-overview-icon"><i data-lucide="terminal" style="width:16px;height:16px;"></i></div><div class="onboarding-overview-text"><strong>AI Terminal</strong><span>Launch Claude, Gemini, Copilot, Codex, Grok, or Qwen inline</span></div></div>
      <div class="onboarding-overview-item"><div class="onboarding-overview-icon"><i data-lucide="bot" style="width:16px;height:16px;"></i></div><div class="onboarding-overview-text"><strong>AI Tools</strong><span>Detect and install AI assistants</span></div></div>
      <div class="onboarding-overview-item"><div class="onboarding-overview-icon"><i data-lucide="folder-git-2" style="width:16px;height:16px;"></i></div><div class="onboarding-overview-text"><strong>Repositories</strong><span>Add local repos to browse and edit code</span></div></div>
      <div class="onboarding-overview-item"><div class="onboarding-overview-icon"><i data-lucide="puzzle" style="width:16px;height:16px;"></i></div><div class="onboarding-overview-text"><strong>Plugins (optional)</strong><span>Azure DevOps, GitHub, Jira, Wrike, Builder.io, Sanity, WordPress, and more</span></div></div>
    </div>
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--surface1);display:flex;gap:8px;justify-content:center;">
      <button class="onboarding-btn onboarding-btn-secondary" onclick="obImportSettings()" style="font-size:11px;padding:6px 16px;opacity:0.85;">
        <i data-lucide="upload" style="width:12px;height:12px;vertical-align:-2px;margin-right:4px;"></i> Import settings from another machine
      </button>
    </div>`
}),
// 2: Theme picker (fresh-start only; import path skips the wizard entirely)
() => ({
  title: 'Pick a theme',
  subtitle: 'Choose a look for Symphonee. You can change this any time from Settings > Appearance.',
  html: function () {
    const sel = state._obData.theme || 'industrial-blue';
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:8px;">
        ${BUILTIN_THEMES.map(t => {
      const isSel = t.id === sel ? ' selected' : '';
      return `<button type="button" class="ob-theme-card${isSel}" data-theme-id="${t.id}" onclick="obPickTheme('${t.id}')"
            style="background:var(--surface0);border:2px solid ${t.id === sel ? 'var(--accent)' : 'var(--surface2)'};border-radius:var(--radius);padding:12px;cursor:pointer;text-align:left;transition:border-color .15s,transform .1s;display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;gap:6px;align-items:center;">
              <span style="width:14px;height:14px;border-radius:50%;background:${t.tint};border:1px solid var(--overlay0);"></span>
              <span style="width:14px;height:14px;border-radius:50%;background:${t.accent};border:1px solid var(--overlay0);"></span>
              <span style="width:14px;height:14px;border-radius:3px;background:${t.text};border:1px solid var(--overlay0);"></span>
            </div>
            <div style="font-size:12px;font-weight:600;color:var(--text);">${esc(t.name)}</div>
            <div style="font-size:10px;color:var(--subtext0);text-transform:uppercase;letter-spacing:0.5px;">${t.mode}</div>
          </button>`;
    }).join('')}
      </div>
      <div class="onboarding-hint" style="margin-top:12px;">Click a theme to preview it instantly. The current terminal(s) will refresh so the new colors apply cleanly.</div>`;
  }()
}),
// 3: Set up local AI (Ollama + brain models) -- REQUIRED + GATED. Comes before
// tools/plugins/repos so the brain is ready by the time the user finishes.
() => ({
  title: 'Set up local AI',
  subtitle: "Symphonee's brain runs locally on Ollama - private, no API keys, no quota. This is required to finish setup, and it's a one-time install.",
  html: `<div id="obBrainStatus" style="margin-top:8px;font-size:12.5px;color:var(--subtext1);line-height:1.6;">Checking local AI...</div>
      <div id="obBrainActions" style="margin-top:16px;display:flex;flex-direction:column;gap:8px;"></div>`,
  onEnter: () => obCheckBrain(),
  validate: () => state._obBrainReady,
  validateMsg: 'Install Ollama and both brain models to continue.',
  nextLabel: 'Next'
}),
// 4: AI Tools
() => ({
  title: 'AI tools (optional)',
  subtitle: 'Symphonee works with AI assistants like Claude, Gemini, and Codex. Install the ones you want now (or later from Settings), then pick your default. Skip if you only need the local AI.',
  html: `<div id="obAiTools" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;"><div style="font-size:11px;color:var(--subtext0);">Detecting...</div></div>
      <div class="onboarding-field"><label>Default AI</label><select id="obDefaultCli" onchange="_obData.defaultCli=this.value" style="padding:8px 10px;font-size:13px;">
        <option value="claude"${state._obData.defaultCli === 'claude' ? ' selected' : ''}>Claude Code</option>
        <option value="gemini"${state._obData.defaultCli === 'gemini' ? ' selected' : ''}>Gemini CLI</option>
        <option value="copilot"${state._obData.defaultCli === 'copilot' ? ' selected' : ''}>Copilot CLI</option>
        <option value="codex"${state._obData.defaultCli === 'codex' ? ' selected' : ''}>Codex CLI</option>

        <option value="grok"${state._obData.defaultCli === 'grok' ? ' selected' : ''}>Grok Code</option>
        <option value="qwen"${state._obData.defaultCli === 'qwen' ? ' selected' : ''}>Qwen Code</option>
      </select></div>
      <div class="onboarding-hint">Don't have any installed? Each tool has a one-click Install button above. They require <code>npm</code> (Node.js) which is already installed since this app is running.</div>`,
  onEnter: () => obDetectAiTools()
}),
// 4: Install Plugins (optional)
() => ({
  title: 'Install Plugins (optional)',
  subtitle: 'Browse the plugin registry and install whatever integrations you need. You can always add more later from Settings > Plugins > Browse.',
  html: `<div id="obPluginList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;max-height:380px;overflow-y:auto;">
        <div style="font-size:11px;color:var(--subtext0);padding:8px;">Loading plugins...</div>
      </div>
      <div class="onboarding-hint">Each install clones the plugin repo into <code>dashboard/plugins/</code>. Configure them in Settings after onboarding finishes. Click Next to skip.</div>`,
  onEnter: () => obLoadPluginRegistry()
}),
// 5: Azure DevOps config form - shown only when the azure-devops plugin is installed.
// A future Jira/Wrike plugin can ship its own onboarding step via a manifest
// contribution; this step exists only for the first-party ADO plugin.
() => ({
  _requires: 'azure-devops',
  title: 'Azure DevOps (optional)',
  subtitle: 'If you use Azure Boards, fill these in to enable the Backlog tab, iterations, and AB# commit linking. Leave blank to skip - you can install it later from Settings > Plugins.',
  html: `<div class="onboarding-field"><label>Organization</label><input id="obOrg" type="text" placeholder="e.g. my-org" value="${esc(state._obData.org)}" oninput="_obData.org=this.value"></div>
      <div class="onboarding-field"><label>Project</label><input id="obProject" type="text" placeholder="e.g. My Project" value="${esc(state._obData.project)}" oninput="_obData.project=this.value"></div>
      <div class="onboarding-field"><label>Personal Access Token</label><input id="obPat" type="password" placeholder="Your PAT" value="${esc(state._obData.pat)}" oninput="_obData.pat=this.value"></div>
      <div class="onboarding-hint">
        <strong>How to get your PAT:</strong><br>
        1. Go to <a href="https://dev.azure.com" target="_blank">dev.azure.com</a> and sign in<br>
        2. Click your avatar (top right) &rarr; <strong>Personal Access Tokens</strong><br>
        3. Click <strong>New Token</strong>, give it a name, set expiration<br>
        4. Under Scopes, select <strong>Work Items: Read & Write</strong> and <strong>Code: Read & Write</strong><br>
        5. Click Create and copy the token
      </div>
      <div class="onboarding-field" style="margin-top:14px;"><label>Default Team</label><input id="obTeam" type="text" placeholder="e.g. My Project Team (optional)" value="${esc(state._obData.team)}" oninput="_obData.team=this.value"></div>
      <div class="onboarding-field"><label>Display Name (must match your Azure DevOps name)</label><input id="obAdoName" type="text" value="${esc(state._obData.displayName)}" oninput="_obData.displayName=this.value">
      <div style="font-size:10px;color:var(--subtext0);margin-top:3px;">This needs to match exactly how your name appears in Azure DevOps for "My Items" to work.</div></div>`
}),
// 6: Repositories
() => ({
  title: 'Repositories (optional)',
  subtitle: 'Point Symphonee at the local repos you work with - for file browsing, diffs, commits, and pull requests. Add one now or any time later from the repo picker.',
  html: `<div id="obRepoList" style="margin-bottom:10px;"></div>
      <div id="obRepoAddBtns" style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;">
        <button class="onboarding-btn onboarding-btn-primary" onclick="repoAddBrowse('ob')" style="padding:8px 14px;flex:1;display:flex;align-items:center;justify-content:center;gap:4px;">
          <i data-lucide="folder-open" style="width:13px;height:13px;"></i> Browse Local
        </button>
      </div>
      <div id="obRepoAddPanel" style="display:none;"></div>
      <div class="onboarding-hint">
        <strong>Browse Local</strong> opens a folder picker and adds the repo automatically.<br>
        <strong>Clone from X</strong> buttons appear per installed repo-source plugin.
      </div>`,
  onEnter: () => {
    obRenderRepos();
    renderCloneSourceButtons('obRepoAddBtns', 'ob', 'onboarding-btn onboarding-btn-primary');
  }
}),
// 7: GitHub PAT (optional). Renders only when the github plugin is installed.
() => ({
  title: function () {
    const hasGh = !!(window._loadedPluginsRaw || []).some(p => p.id === 'github');
    return hasGh ? 'GitHub (optional)' : 'Optional integrations';
  }(),
  subtitle: function () {
    const hasGh = !!(window._loadedPluginsRaw || []).some(p => p.id === 'github');
    return hasGh ? 'GitHub unlocks the Pull Requests tab, git log, and clone-from-GitHub. Optional - leave blank to skip.' : 'Nothing to configure here - you are all set.';
  }(),
  html: function () {
    const hasGh = !!(window._loadedPluginsRaw || []).some(p => p.id === 'github');
    const ghBlock = hasGh ? `<div class="onboarding-section-title">GitHub</div>
        <div class="onboarding-field"><label>Personal Access Token</label><input id="obGhPat" type="password" placeholder="ghp_..." value="${esc(state._obData.ghPat)}" oninput="_obData.ghPat=this.value"></div>
        <div class="onboarding-hint" style="margin-bottom:18px;">
          <strong>How to get your GitHub PAT:</strong><br>
          1. Go to <a href="https://github.com/settings/tokens" target="_blank">github.com/settings/tokens</a><br>
          2. Click <strong>Generate new token (classic)</strong><br>
          3. Select the <strong>repo</strong> scope<br>
          4. Click Generate and copy the <code>ghp_...</code> token<br>
          5. If your org uses SAML/SSO, click <strong>Configure SSO</strong> next to the token and authorize it
        </div>` : '';
    return ghBlock;
  }()
}),
// 8: Final -- everything is set up; Complete restarts into a ready Symphonee.
() => ({
  title: "You're all set!",
  subtitle: 'Everything you chose is installed and configured. Clicking Complete restarts Symphonee so it all activates - then you can just start working.',
  html: `<div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">
        <div class="onboarding-overview-item"><div class="onboarding-overview-icon"><i data-lucide="cpu" style="width:16px;height:16px;"></i></div><div class="onboarding-overview-text"><strong>Local AI ready</strong><span>Ollama + the brain models are installed</span></div></div>
        <div class="onboarding-overview-item"><div class="onboarding-overview-icon"><i data-lucide="bot" style="width:16px;height:16px;"></i></div><div class="onboarding-overview-text"><strong>AI tools & plugins</strong><span>Whatever you installed is wired up</span></div></div>
        <div class="onboarding-overview-item"><div class="onboarding-overview-icon"><i data-lucide="search" style="width:16px;height:16px;"></i></div><div class="onboarding-overview-text"><strong>Command palette</strong><span>Press <code style="background:var(--surface0);padding:1px 4px;border-radius:2px;font-size:10px;">Ctrl+K</code> to jump anywhere or ask a quick question</span></div></div>
      </div>
      <div style="margin-top:16px;padding:10px 12px;background:var(--surface0);border-radius:var(--radius);font-size:11px;color:var(--subtext0);border-left:2px solid var(--accent);">
        Tip: manage everything later from Settings (bottom-left). Guided video walkthroughs are coming soon.
      </div>`,
  nextLabel: 'Complete & Restart'
})];
state._obInstalledPluginIds = new Set();
async function _obRefreshInstalledPlugins() {
  try {
    const r = await fetch('/api/plugins/installed', {
      cache: 'no-store'
    });
    if (r.ok) {
      const list = await r.json();
      state._obInstalledPluginIds = new Set((list || []).map(p => p.id));
      return;
    }
  } catch (_) {}
  // Fallback to active list if the installed endpoint is unavailable.
  state._obInstalledPluginIds = new Set((state._loadedPlugins || []).map(p => p.id));
  window._loadedPluginsRaw = Array.from(state._obInstalledPluginIds).map(id => ({
    id
  }));
}
function _obHasPlugin(id) {
  return state._obInstalledPluginIds.has(id);
}
async function startOnboarding() {
  state._obStep = 0;
  state._obData = {
    displayName: '',
    org: '',
    project: '',
    pat: '',
    team: '',
    ghPat: '',
    defaultCli: 'claude',
    repos: {},
    theme: (localStorage.getItem(ACTIVE_THEME_KEY) || '').replace('__builtin_', '') || 'industrial-blue'
  };
  await _obRefreshInstalledPlugins();
  window._loadedPluginsRaw = Array.from(state._obInstalledPluginIds).map(id => ({
    id
  }));
  document.getElementById('onboarding').classList.add('visible');
  obRender();
}

// Keyboard control: Enter advances (textareas keep their newline; modifier combos ignored).
document.addEventListener('keydown', e => {
  const ob = document.getElementById('onboarding');
  if (!ob || !ob.classList.contains('visible')) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    obNav(1);
  }
});
function obSkipToEnd() {
  state._obStep = OB_STEPS.length - 1;
  obRender();
}
function _obStepIsApplicable(idx) {
  const fn = OB_STEPS[idx];
  if (!fn) return false;
  // Peek at the step's metadata by calling it; most step functions are cheap.
  // Steps can declare a `_requires: '<pluginId>'` field that hides the step
  // unless the plugin is installed. This keeps onboarding plugin-driven so a
  // Jira-only or "no code host" user never sees the ADO or GitHub forms.
  try {
    const s = fn();
    if (s && s._requires) return _obHasPlugin(s._requires);
  } catch (_) {}
  return true;
}
function _obNextApplicable(idx, dir) {
  let i = idx;
  const n = OB_STEPS.length;
  while (i >= 0 && i < n && !_obStepIsApplicable(i)) {
    i += dir;
  }
  if (i < 0) i = 0;
  if (i >= n) i = n - 1;
  return i;
}
function obRender() {
  // If the current step was skipped (e.g. plugin uninstalled mid-onboarding),
  // advance to the next applicable step before rendering.
  if (!_obStepIsApplicable(state._obStep)) state._obStep = _obNextApplicable(state._obStep, 1);
  const step = OB_STEPS[state._obStep]();
  const body = document.getElementById('onboardingBody');
  body.innerHTML = `<div class="onboarding-title">${step.title}</div><div class="onboarding-subtitle">${step.subtitle}</div>${step.html}`;
  // Re-trigger the step-in animation on every render (typeform-style transition).
  body.classList.remove('ob-step-in');
  void body.offsetWidth;
  body.classList.add('ob-step-in');
  // Dots
  const dots = document.getElementById('onboardingDots');
  const applicable = OB_STEPS.map((_, i) => _obStepIsApplicable(i) ? i : -1).filter(i => i >= 0);
  const dotActiveIdx = applicable.indexOf(state._obStep);
  dots.innerHTML = applicable.map((_, visI) => `<div class="onboarding-dot${visI === dotActiveIdx ? ' active' : visI < dotActiveIdx ? ' done' : ''}"></div>`).join('');
  const _pf = document.getElementById('obProgressFill');
  if (_pf) _pf.style.width = (applicable.length ? Math.round((dotActiveIdx + 1) / applicable.length * 100) : 0) + '%';
  // Buttons
  document.getElementById('obBack').style.display = state._obStep === 0 ? 'none' : '';
  const nextBtn = document.getElementById('obNext');
  nextBtn.textContent = step.nextLabel || (state._obStep === OB_STEPS.length - 1 ? 'Get Started' : 'Next');
  try {
    lucide.createIcons();
  } catch (_) {}
  if (step.onEnter) step.onEnter();
  // Keyboard-first: focus the first field so the user can just type.
  const _fi = body.querySelector('input, select, textarea');
  if (_fi) setTimeout(() => {
    try {
      _fi.focus();
    } catch (_) {}
  }, 60);
}
async function obNav(dir) {
  if (dir > 0) {
    const step = OB_STEPS[state._obStep]();
    if (step.validate && !step.validate()) {
      toast(step.validateMsg || 'Please fill in the required field', 'info');
      return;
    }
    if (state._obStep === OB_STEPS.length - 1) {
      await obFinish();
      return;
    }
  }
  let next = Math.max(0, Math.min(OB_STEPS.length - 1, state._obStep + dir));
  // Skip non-applicable steps (plugin-gated) in the travel direction.
  next = _obNextApplicable(next, dir >= 0 ? 1 : -1);
  state._obStep = next;
  obRender();
}
async function obFinish() {
  const payload = {
    AzureDevOpsOrg: state._obData.org.trim(),
    AzureDevOpsProject: state._obData.project.trim(),
    AzureDevOpsProjects: state._obData.project.trim() ? [state._obData.project.trim()] : [],
    AzureDevOpsPAT: state._obData.pat.trim(),
    DefaultTeam: state._obData.team.trim(),
    DefaultUser: state._obData.displayName.trim(),
    DefaultCli: state._obData.defaultCli,
    GitHubPAT: state._obData.ghPat.trim(),
    Repos: state._obData.repos
  };
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (_) {}
  // If the user installed any plugins during the Plugins step, they won't
  // activate until the server picks up the new directories. The install
  // endpoint returns a "Restart app to activate" message; easiest path is
  // to let refreshPluginActivation detect the delta and trigger a restart.
  document.getElementById('onboarding').classList.remove('visible');
  showLoading('Loading...');
  const minWait = new Promise(r => setTimeout(r, 4000));
  try {
    const delta = await refreshPluginActivation();
    if (delta.added && delta.added.length || delta.removed && delta.removed.length) {
      await minWait;
      hideLoading();
      toast('Plugins installed. Restarting to activate...', 'success');
      setTimeout(() => restartApp(), 500);
      return;
    }
  } catch (_) {}
  if (state._obNeedsRestart) {
    await minWait;
    hideLoading();
    toast('Finishing setup - restarting...', 'success');
    setTimeout(() => restartApp(), 500);
    return;
  }
  await loadConfig(true);
  loadVelocity();
  if (state._obData.defaultCli) switchCli(state._obData.defaultCli);
  await minWait;
  hideLoading();
  toast('Setup complete!', 'success');
}
async function obLoadPluginRegistry() {
  const container = document.getElementById('obPluginList');
  if (!container) return;
  try {
    const recPromise = loadPluginRecommendations();
    const r = await fetch('/api/plugins/registry');
    const data = await r.json();
    const recs = await recPromise;
    if (data.error) {
      container.innerHTML = '<div style="font-size:12px;color:var(--red);padding:8px;">Registry fetch failed: ' + esc(data.error) + '</div>';
      return;
    }
    const plugins = sortPluginsWithRecommendations(data.plugins || [], recs);
    if (!plugins.length) {
      container.innerHTML = '<div style="font-size:12px;color:var(--subtext0);padding:8px;">No plugins available.</div>';
      return;
    }
    container.innerHTML = plugins.map(function (p) {
      const installed = p.installed;
      const rec = recs[p.id];
      const tintStyle = p.tint ? 'border-left:3px solid rgb(' + p.tint + ');' : '';
      const btn = installed ? '<button class="onboarding-btn onboarding-btn-secondary" disabled style="opacity:0.6;">Installed</button>' : '<button class="onboarding-btn onboarding-btn-primary" onclick="obInstallPlugin(\'' + p.id + '\', this)" style="font-size:11px;padding:6px 14px;">Install</button>';
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface0);border-radius:var(--radius);' + tintStyle + '">' + '<div style="flex:1;min-width:0;">' + '<div style="font-size:13px;font-weight:600;color:var(--text);">' + esc(p.name || p.id) + ' <span style="font-size:10px;color:var(--subtext0);font-weight:400;">v' + esc(p.version || '0') + '</span>' + (rec && !installed ? ' <span style="font-size:10px;color:var(--green);font-weight:600;margin-left:6px;">Recommended</span>' : '') + '</div>' + '<div style="font-size:11px;color:var(--subtext0);margin-top:2px;line-height:1.4;">' + esc(p.description || '') + '</div>' + (rec && rec.reasons && rec.reasons.length ? '<div style="font-size:10px;color:var(--green);margin-top:4px;">' + esc(rec.reasons[0]) + '</div>' : '') + '</div>' + btn + '</div>';
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="font-size:12px;color:var(--red);padding:8px;">Failed to load registry: ' + esc(e.message) + '</div>';
  }
}
async function obInstallPlugin(id, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Installing...';
  }
  try {
    // Look up repo URL from the registry response cached in DOM context.
    const regRes = await fetch('/api/plugins/registry');
    const reg = await regRes.json();
    const entry = (reg.plugins || []).find(p => p.id === id);
    if (!entry || !entry.repo) throw new Error('Plugin not found in registry');
    const r = await fetch('/api/plugins/install-from-registry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id,
        repo: entry.repo
      })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'Install failed');
    if (btn) {
      btn.textContent = 'Installed';
      btn.disabled = true;
      btn.style.opacity = '0.6';
    }
    toast((entry.name || id) + ' installed - restart at the end to activate', 'success');
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Install';
    }
    toast('Install failed: ' + e.message, 'error');
  }
}
async function obDetectAiTools() {
  const container = document.getElementById('obAiTools');
  if (!container) return;
  container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);">Detecting installed AI tools...</div>';
  try {
    const res = await fetch('/api/prerequisites');
    const data = await res.json();
    state._obAiStatus = data.cliTools || {};
    state._obPwshStatus = data.pwsh || {
      installed: false
    };
    obRenderAiTools();
  } catch (_) {
    container.innerHTML = '<div style="font-size:11px;color:var(--red);">Failed to detect AI tools</div>';
  }
}
state._obPwshStatus = {
  installed: false
}; // Same in-flight tracker as the Settings AI tools (_aiInstalling): survives the
// full obRenderAiTools() re-render so a sibling install finishing does not reset
// a still-installing tool to "Install".
const _obInstalling = new Set();
function obRenderAiTools() {
  const container = document.getElementById('obAiTools');
  if (!container) return;

  // PowerShell 7 prerequisite
  const pwshOk = state._obPwshStatus.installed;
  const pwshInstalling = _obInstalling.has('pwsh');
  const pwshBtn = pwshInstalling ? `<button class="ai-tool-btn installing" id="obAiBtn-pwsh" disabled>Installing...</button>` : `<button class="ai-tool-btn ${pwshOk ? 'installed' : 'install'}" id="obAiBtn-pwsh" onclick="${pwshOk ? '' : "obInstallCli('pwsh')"}" ${pwshOk ? 'disabled' : ''}>${pwshOk ? 'Installed' : 'Install'}</button>`;
  const pwshCard = `
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--subtext0);margin-bottom:6px;">Prerequisites</div>
    <div class="ai-tool-card" style="${pwshOk ? '' : 'border-color:var(--yellow);'}">
      <div class="ai-tool-dot" style="background:var(--blue)"></div>
      <div class="ai-tool-info"><div class="ai-tool-name">PowerShell 7</div>
        ${pwshOk ? '<span class="ai-tool-status installed">Installed</span>' : '<span class="ai-tool-status not-installed" style="color:var(--yellow);">Required for AI CLI tools</span>'}
      </div>
      ${pwshBtn}
    </div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--subtext0);margin:8px 0 6px;">AI Tools</div>`;

  // AI tool cards
  const meta = {
    claude: {
      name: 'Claude Code',
      color: '#d97757',
      pkg: '@anthropic-ai/claude-code'
    },
    gemini: {
      name: 'Gemini CLI',
      color: '#078efa',
      pkg: '@google/gemini-cli'
    },
    copilot: {
      name: 'Copilot CLI',
      color: '#8534f3',
      pkg: '@github/copilot'
    },
    codex: {
      name: 'Codex CLI',
      color: '#10a37f',
      pkg: '@openai/codex'
    },
    grok: {
      name: 'Grok Code',
      color: '#ef4444',
      pkg: '@webdevtoday/grok-cli'
    }
  };
  const toolCards = Object.entries(meta).map(([id, m]) => {
    const installed = state._obAiStatus[id]?.installed;
    const installing = _obInstalling.has(id);
    const btn = installing ? `<button class="ai-tool-btn installing" id="obAiBtn-${id}" disabled>Installing...</button>` : `<button class="ai-tool-btn ${installed ? 'installed' : 'install'}" id="obAiBtn-${id}" onclick="${installed ? '' : `obInstallCli('${id}')`}" ${installed ? 'disabled' : ''}>${installed ? 'Installed' : 'Install'}</button>`;
    return `<div class="ai-tool-card">
      <div class="ai-tool-dot" style="background:${m.color}"></div>
      <div class="ai-tool-info"><div class="ai-tool-name">${m.name}</div>
        ${installed ? '<span class="ai-tool-status installed">Installed</span>' : `<span class="ai-tool-status not-installed">Not installed</span>`}
      </div>
      ${btn}
    </div>`;
  }).join('');
  container.innerHTML = pwshCard + toolCards;
}
async function obInstallCli(cli) {
  const btn = document.getElementById(`obAiBtn-${cli}`);
  if (!btn) return;
  _obInstalling.add(cli);
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
    if (data.ok && data.installed) {
      if (cli === 'pwsh') {
        state._obPwshStatus = {
          installed: true,
          path: data.path
        };
      } else {
        state._obAiStatus[cli] = {
          installed: true
        };
      }
      if (data.needsRestart) {
        toast('Installed! Restart the app so the terminal can use it.', 'success');
      } else {
        toast('Installed!', 'success');
      }
      _obInstalling.delete(cli);
      obRenderAiTools();
    } else {
      _obInstalling.delete(cli);
      btn.className = 'ai-tool-btn install';
      btn.textContent = 'Retry';
      btn.disabled = false;
      const errMsg = data.error || 'Install failed';
      toast(`Install failed: ${errMsg}`, 'error');
      if (data.fallbackCmd) {
        showInstallFallbackHint(btn, data.fallbackCmd, errMsg);
      }
    }
  } catch (_) {
    _obInstalling.delete(cli);
    btn.className = 'ai-tool-btn install';
    btn.textContent = 'Retry';
    btn.disabled = false;
  }
}
function showInstallFallbackHint(btn, cmd, msg) {
  const card = btn.closest('.ai-tool-card');
  if (!card) return;
  // Don't add duplicate hints
  const existing = card.parentElement.querySelector('.install-fallback-hint');
  if (existing && existing.previousElementSibling === card) existing.remove();
  const hint = document.createElement('div');
  hint.className = 'install-fallback-hint';
  const label = msg || 'Could not install automatically.';
  hint.innerHTML = `<span style="color:var(--yellow);">${label}</span> You can install it manually - open a terminal and run:<code class="install-fallback-cmd" onclick="navigator.clipboard.writeText('${cmd}');toast('Copied to clipboard','success');" title="Click to copy">${cmd}</code>`;
  card.insertAdjacentElement('afterend', hint);
}
async function obImportSettings() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    let text;
    try {
      text = await file.text();
      JSON.parse(text);
    } catch (_) {
      toast('Invalid settings file', 'error');
      return;
    }
    // Hide the onboarding and show a persistent loading screen right away so
    // the user sees something is happening while the server downloads and
    // installs plugins (this call can take several seconds).
    document.getElementById('onboarding').classList.remove('visible');
    showLoading('Importing settings and installing plugins...');
    // Cancel the 8-second auto-hide; we control when to hide this overlay.
    try {
      clearTimeout(state._loadingTimer);
    } catch (_) {}
    try {
      const res = await fetch('/api/config/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.parse(text))
      });
      const result = await res.json().catch(() => ({}));
      if (!result || !result.ok) {
        hideLoading();
        toast('Import failed: ' + (result && result.error ? result.error : 'Unknown error'), 'error');
        return;
      }
      // Update the loading label so the user knows we are nearly done.
      try {
        const plugins = Array.isArray(result.pluginsInstalled) ? result.pluginsInstalled : [];
        const label = document.getElementById('loadingLabel');
        if (label) {
          label.textContent = plugins.length ? 'Installed ' + plugins.length + ' plugin(s). Restarting app...' : 'Settings imported. Restarting app...';
        }
      } catch (_) {}
      // Always restart after a successful import so plugins, themes, and
      // other settings load cleanly for the user.
      setTimeout(() => restartApp(), 800);
    } catch (err) {
      hideLoading();
      toast('Import failed: ' + (err && err.message ? err.message : 'network error'), 'error');
    }
  };
  input.click();
}
function obRenderRepos() {
  const container = document.getElementById('obRepoList');
  if (!container) return;
  const entries = Object.entries(state._obData.repos);
  if (!entries.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:4px 0;">No repositories added yet.</div>';
    return;
  }
  container.innerHTML = entries.map(([name, path]) => `<div class="onboarding-repo-item"><span class="onboarding-repo-name">${esc(name)}</span><span class="onboarding-repo-path">${esc(path)}</span><button class="onboarding-repo-del" onclick="obRemoveRepo('${esc(name)}')">&times;</button></div>`).join('');
}
function obAddRepo() {
  const name = document.getElementById('obRepoName')?.value.trim();
  const path = document.getElementById('obRepoPath')?.value.trim();
  if (!name || !path) return;
  state._obData.repos[name] = path;
  document.getElementById('obRepoName').value = '';
  document.getElementById('obRepoPath').value = '';
  obRenderRepos();
}
function obRemoveRepo(name) {
  delete state._obData.repos[name];
  obRenderRepos();
}
function renderHtmlBody(html) {
  if (!html) return '';
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '').replace(/<details>/gi, '<details open>');
}
function wrapStandaloneListItems(html) {
  if (!html || html.indexOf('<li') === -1) return html || '';
  return html.replace(/((?:<(?:li)\b[^>]*data-list-kind="(ul|ol)"[^>]*>[\s\S]*?<\/li>\s*)+)/g, (_, block, kind) => {
    const cleaned = block.replace(/\sdata-list-kind="(?:ul|ol)"/g, '');
    return `<${kind}>${cleaned}</${kind}>`;
  });
}
function renderMarkdown(text) {
  if (!text) return '';
  // Extract code blocks FIRST — before ANY other processing, to prevent content inside
  // code blocks from being transformed or triggering the "already HTML" branch
  const earlyCodeBlocks = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = esc(code.trimEnd());
    const langClass = lang ? ` class="language-${lang}"` : '';
    earlyCodeBlocks.push(`<pre style="background:var(--crust);padding:12px 16px;border-radius:var(--radius);overflow-x:auto;font:12px var(--font-mono);margin:8px 0;border:1px solid var(--surface0);white-space:pre;"><code${langClass}>${escaped}</code></pre>`);
    return `%%EARLYCODE_${earlyCodeBlocks.length - 1}%%`;
  });
  // Process core markdown formatting BEFORE link conversion (links create <a> tags
  // which trigger the HTML branch that skips markdown parsing)
  // Bold and italic (must come before list processing since lists contain bold)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*([^\s*](?:.*?[^\s*])?)\*(?!\*)/g, '<em>$1</em>');
  // Headers
  text = text.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  text = text.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  text = text.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Tables — process early so the HTML-detection branch does not skip them
  text = text.replace(/((?:^\|.+\|[ \t]*$\n?)+)/gm, block => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return block;
    const isSep = /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/.test(rows[1].trim());
    if (!isSep) return block;
    // Parse alignment from separator row
    const aligns = rows[1].split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    const hCells = rows[0].split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
    let thead = '<thead><tr>' + hCells.map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${c.trim()}</th>`).join('') + '</tr></thead>';
    const bodyRows = rows.slice(2);
    let tbody = '<tbody>' + bodyRows.map(r => {
      const cells = r.split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
      return '<tr>' + cells.map((c, i) => `<td style="text-align:${aligns[i] || 'left'}">${c.trim()}</td>`).join('') + '</tr>';
    }).join('') + '</tbody>';
    return `<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`;
  });
  // Lists
  text = text.replace(/^\d+\. (.+)$/gm, '<li data-list-kind="ol" style="margin-left:16px;margin-bottom:2px;">$1</li>');
  text = text.replace(/^[-*] (.+)$/gm, '<li data-list-kind="ul" style="margin-left:16px;margin-bottom:2px;">$1</li>');
  // Convert markdown images to <img> (works for both HTML and markdown paths)
  // Nested: [![alt](img)](link)
  text = text.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, '<a href="$3" target="_blank"><img src="$2" alt="$1"></a>');
  // Simple: ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  // Convert markdown links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // Strip markdown comments: [//]: # (...)
  text = text.replace(/\[\/\/\]: #[^\n]*/g, '');
  // GitHub callouts in markdown: > [!NOTE]\n> content
  const calloutIcons = {
    note: '&#x1F4DD;',
    tip: '&#x1F4A1;',
    important: '&#x2757;',
    warning: '&#x26A0;&#xFE0F;',
    caution: '&#x1F6D1;'
  };
  text = text.replace(/(?:^|\n)> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n((?:> .*(?:\n|$))*)/gi, (_, type, body) => {
    const t = type.toLowerCase();
    const content = body.replace(/^> ?/gm, '').trim();
    return `\n<div class="pr-callout pr-callout-${t}"><div class="pr-callout-title">${calloutIcons[t] || ''} ${t}</div>${content}</div>\n`;
  });
  // If the text contains HTML tags, it's already HTML from GitHub — render directly
  if (/<[a-z][\s\S]*>/i.test(text)) {
    // Sanitize: strip <script> and event handlers, allow safe HTML
    let html = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '')
    // Expand <details> sections by default
    .replace(/<details>/gi, '<details open>')
    // Proxy GitHub user-attachment images through the server
    .replace(/src="(https:\/\/github\.com\/user-attachments\/assets\/[^"]+)"/gi, (_, u) => `src="/api/github/image?url=${encodeURIComponent(u)}"`).replace(/src='(https:\/\/github\.com\/user-attachments\/assets\/[^']+)'/gi, (_, u) => `src="/api/github/image?url=${encodeURIComponent(u)}"`);
    // GitHub callouts inside HTML blockquotes: <blockquote><p>[!NOTE]</p><p>content</p></blockquote>
    html = html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]<\/p>([\s\S]*?)<\/blockquote>/gi, (_, type, content) => {
      const t = type.toLowerCase();
      return `<div class="pr-callout pr-callout-${t}"><div class="pr-callout-title">${calloutIcons[t] || ''} ${t}</div>${content}</div>`;
    });
    // Markdown horizontal rules
    html = html.replace(/\n---\n/g, '\n<hr style="border:none;border-top:1px solid var(--surface1);margin:12px 0;">\n');
    html = html.replace(/\n\*\*\*\n/g, '\n<hr style="border:none;border-top:1px solid var(--surface1);margin:12px 0;">\n');
    // Convert newlines to <br>
    html = html.replace(/\n/g, '<br>');
    // Collapse 2+ consecutive <br> into 1 (empty lines were too tall)
    html = html.replace(/(<br>){2,}/gi, '<br>');
    // Clean up <br> around block elements
    html = html.replace(/(<\/(?:h[1-6]|p|li|ul|ol|blockquote|details|summary|pre|div|hr|table|thead|tbody|tr|td|th)>)(<br>)+/gi, '$1');
    html = html.replace(/(<br>)+(<(?:h[1-6]|p|li|ul|ol|blockquote|details|summary|pre|div|hr|table|thead|tbody|tr|td|th)[\s>/])/gi, '$2');
    html = html.replace(/(<br>)+(<\/(?:blockquote|details|ul|ol|div|table|thead|tbody)>)/gi, '$2');
    // Restore early code blocks — clean surrounding <br> tags
    earlyCodeBlocks.forEach((block, i) => {
      html = html.replace(new RegExp(`(<br>)*%%EARLYCODE_${i}%%(<br>)*`, 'g'), block);
    });
    return wrapStandaloneListItems(html);
  }
  // Plain markdown — extract code blocks BEFORE escaping to preserve backticks
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = esc(code.trimEnd());
    const langClass = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre style="background:var(--crust);padding:12px 16px;border-radius:var(--radius);overflow-x:auto;font:12px var(--font-mono);margin:8px 0;border:1px solid var(--surface0);white-space:pre;"><code${langClass}>${escaped}</code></pre>`);
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });
  // Extract inline code before escaping too
  const inlineCode = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCode.push(`<code style="background:var(--surface0);padding:1px 5px;border-radius:3px;font:11px var(--font-mono);">${esc(code)}</code>`);
    return `%%INLINECODE_${inlineCode.length - 1}%%`;
  });
  // Now escape the rest
  let html = esc(text);
  // Tables — match consecutive pipe-delimited lines
  html = html.replace(/((?:^\|.+\|[ ]*$\n?)+)/gm, block => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return block;
    // Check if second row is the separator (|---|---|)
    const isSep = /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/.test(rows[1].trim());
    let thead = '',
      tbody = '';
    const startIdx = isSep ? 2 : 0;
    if (isSep) {
      const cells = rows[0].split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
      thead = `<thead><tr>${cells.map(c => `<th>${c.trim()}</th>`).join('')}</tr></thead>`;
    }
    const bodyRows = rows.slice(startIdx);
    tbody = `<tbody>${bodyRows.map(r => {
      const cells = r.split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
      return `<tr>${cells.map(c => `<td>${c.trim()}</td>`).join('')}</tr>`;
    }).join('')}</tbody>`;
    return `<table>${thead}${tbody}</table>`;
  });
  // Horizontal rules
  html = html.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr>');
  // Headers — use correct heading levels, no inline styles (CSS handles sizing)
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Task lists
  html = html.replace(/^[-*] \[x\] (.+)$/gm, '<li data-list-kind="ul" style="margin-left:16px;margin-bottom:2px;list-style:none;"><input type="checkbox" checked disabled style="margin-right:6px;">$1</li>');
  html = html.replace(/^[-*] \[ \] (.+)$/gm, '<li data-list-kind="ul" style="margin-left:16px;margin-bottom:2px;list-style:none;"><input type="checkbox" disabled style="margin-right:6px;">$1</li>');
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li data-list-kind="ol" style="margin-left:16px;margin-bottom:2px;">$1</li>');
  // Unordered lists
  html = html.replace(/^[-*] (.+)$/gm, '<li data-list-kind="ul" style="margin-left:16px;margin-bottom:2px;">$1</li>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<div style="border-left:3px solid var(--surface1);padding-left:10px;color:var(--subtext0);margin:4px 0;">$1</div>');
  // Line breaks — BEFORE restoring code blocks so \n inside <pre> is preserved
  html = html.replace(/\n/g, '<br>');
  // Collapse 2+ consecutive <br> into 1 (empty lines were too tall)
  html = html.replace(/(<br>){2,}/gi, '<br>');
  // Restore code blocks and inline code AFTER line break conversion
  earlyCodeBlocks.forEach((block, i) => {
    html = html.replace(`%%EARLYCODE_${i}%%`, block);
  });
  codeBlocks.forEach((block, i) => {
    html = html.replace(`%%CODEBLOCK_${i}%%`, block);
  });
  inlineCode.forEach((code, i) => {
    html = html.replace(`%%INLINECODE_${i}%%`, code);
  });
  html = html.replace(/(<\/h[1-6]>)<br>/g, '$1');
  html = html.replace(/(<\/pre>)<br>/g, '$1');
  html = html.replace(/(<\/li>)<br>/g, '$1');
  html = html.replace(/(<\/div>)<br>/g, '$1');
  html = html.replace(/(<\/table>)<br>/g, '$1');
  html = html.replace(/(<\/thead>)<br>/g, '$1');
  html = html.replace(/(<\/tbody>)<br>/g, '$1');
  html = html.replace(/(<\/tr>)<br>/g, '$1');
  html = html.replace(/(<\/td>)<br>/g, '$1');
  html = html.replace(/(<\/th>)<br>/g, '$1');
  html = html.replace(/<br>(<table>)/g, '$1');
  html = html.replace(/(<hr[^>]*>)<br>/g, '$1');
  return wrapStandaloneListItems(html);
}
function formatDate(d) {
  if (!d) return '-';
  const date = new Date(d);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}
function formatRelationType(rel) {
  if (!rel) return '';
  const map = {
    'System.LinkTypes.Hierarchy-Forward': 'Child',
    'System.LinkTypes.Hierarchy-Reverse': 'Parent',
    'System.LinkTypes.Related': 'Related',
    'System.LinkTypes.Dependency-Forward': 'Successor',
    'System.LinkTypes.Dependency-Reverse': 'Predecessor'
  };
  return map[rel] || rel.split('.').pop();
}
function confirmDialog(message, {
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false
} = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
    const accentColor = danger ? 'var(--red)' : 'var(--accent)';
    overlay.innerHTML = '<div style="background:var(--base);border:1px solid var(--surface1);border-radius:var(--radius-lg);padding:0;width:400px;max-width:90vw;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.6);">' + '<div style="padding:20px 24px 12px;font-size:13px;color:var(--text);line-height:1.5;">' + message.replace(/</g, '&lt;') + '</div>' + '<div style="padding:12px 24px 16px;display:flex;gap:8px;justify-content:flex-end;">' + '<button id="_confirmNo" style="padding:8px 16px;background:var(--surface1);color:var(--text);border:none;border-radius:var(--radius);font:12px var(--font-ui);cursor:pointer;transition:background 0.1s;">' + cancelText + '</button>' + '<button id="_confirmYes" style="padding:8px 16px;background:' + accentColor + ';color:var(--crust);border:none;border-radius:var(--radius);font:12px var(--font-ui);font-weight:600;cursor:pointer;transition:opacity 0.1s;">' + confirmText + '</button>' + '</div>' + '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#_confirmYes').onclick = () => {
      overlay.remove();
      resolve(true);
    };
    overlay.querySelector('#_confirmNo').onclick = () => {
      overlay.remove();
      resolve(false);
    };
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(false);
      }
    });
  });
}
function toast(msg, type = 'info', options) {
  options = options || {};
  // Audible cue per severity. Skipped when options.silent is truthy.
  if (!options.silent) playNotifSound(type);
  // Unified toast path: use the rich bottom-right stack for normal UI
  // feedback so messages stack consistently and share one visual language.
  if (!options.compact) {
    return richToast(msg, type, options);
  }
  const id = 'toast-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
  const icon = type === 'success' ? 'check' : type === 'error' ? 'alert-circle' : type === 'warning' ? 'alert-triangle' : 'info';
  const status = type === 'success' ? 'done' : type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
  _bgTasks.set(id, {
    label: msg,
    status,
    startTime: Date.now(),
    endTime: Date.now(),
    icon
  });
  renderTaskPills();
  const dur = options && options.duration || 3500;
  setTimeout(() => {
    const el = document.querySelector(`.task-pill[data-id="${id}"]`);
    if (el) el.classList.add('leaving');
    setTimeout(() => {
      _bgTasks.delete(id);
      renderTaskPills();
    }, 300);
  }, dur);
  return id;
}
function richToast(msg, type = 'info', options = {}) {
  const stack = document.getElementById('richToastStack');
  if (!stack) return null;
  const id = 'rt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
  const iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'alert-circle' : type === 'warning' ? 'alert-triangle' : 'info';
  const el = document.createElement('div');
  el.className = 'rich-toast ' + type;
  el.dataset.id = id;
  el.innerHTML = '<i data-lucide="' + iconName + '" class="rich-toast-icon"></i>' + '<div class="rich-toast-msg"></div>' + (options.action ? '<button class="rich-toast-action" data-role="action">' + esc(options.action.label || 'Action') + '</button>' : '') + '<button class="rich-toast-close" data-role="close" title="Dismiss"><i data-lucide="x" style="width:12px;height:12px;"></i></button>';
  el.querySelector('.rich-toast-msg').textContent = String(msg);
  stack.appendChild(el);
  try {
    lucide.createIcons({
      nodes: [el]
    });
  } catch (_) {}
  const close = () => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => {
      el.remove();
    }, 180);
  };
  el.querySelector('[data-role="close"]').addEventListener('click', close);
  if (options.action) {
    el.querySelector('[data-role="action"]').addEventListener('click', () => {
      try {
        options.action.onClick && options.action.onClick();
      } catch (e) {
        console.error('toast action:', e);
      }
      if (!options.action.keepOpen) close();
    });
  }
  const duration = options.duration || (options.action ? 6000 : 3500);
  if (duration > 0) setTimeout(close, duration);
  return {
    id,
    close
  };
}// ── Re-focus terminal when window regains focus ─────────────────────────
window.addEventListener('focus', () => {
  const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
  if (activeTab === 'terminal') {
    const t = getActiveTerm();
    if (t) t.focus();
  }
});

// ── Force whole-document repaint on focus / visibility return ───────────
// User-reported bug: alt-tab back into Symphonee and EVERYTHING outside
// the actively-animating regions (terminal canvas / 3D canvas) stays as
// the stale pre-blur compositor layer. The user sees a black UI around
// the terminal and clicking anywhere fixes it because any DOM event
// invalidates the layers as a side effect.
//
// webContents.invalidate() in Electron main isn't enough on its own —
// some Windows compositor configs keep presenting the cached tiles
// regardless. The reliable fix is to toggle a CSS property on the
// document root that forces Chromium to re-rasterize every layer.
//
// `transform: translateZ(0)` is a no-op visually but it promotes the
// element into its own composited layer, which forces the GPU to
// re-rasterize it. Toggling it for one frame and removing it sidesteps
// any layout/paint cost — the layer just gets repainted clean.
function forceFullRepaint() {
  try {
    const el = document.documentElement;
    el.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => {
      try {
        el.style.transform = '';
      } catch (_) {}
    });
  } catch (_) {}
}
window.addEventListener('focus', forceFullRepaint);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') forceFullRepaint();
});

// ── Close modals on overlay click ───────────────────────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ── Sequence shortcuts (vim-style: press "g", then next key) ─────────────
// g t -> Terminal, g f -> Files, g n -> Notes, g o -> Orchestrator,
// g g -> Git, g s -> Settings, g k -> Palette, g b -> Backlog (if plugin).
state._seqPrefix = null;
state._seqTimer = null;
function _clearSeq() {
  state._seqPrefix = null;
  if (state._seqTimer) {
    clearTimeout(state._seqTimer);
    state._seqTimer = null;
  }
}
function _runSeqKey(key) {
  try {
    markOnboarding('shortcut');
  } catch (_) {}
  const map = {
    t: () => switchTab('terminal'),
    f: () => switchTab('files'),
    n: () => switchTab('notes'),
    o: () => {
      const btn = document.getElementById('orchestratorTabBtn');
      if (btn && btn.style.display !== 'none') switchTab('orchestrator');else toast('Orchestrator is hidden', 'warning');
    },
    g: () => {
      try {
        openGitModal('branches');
      } catch (_) {
        toast('Git modal unavailable', 'warning');
      }
    },
    s: () => {
      try {
        openSettings();
      } catch (_) {}
    },
    k: () => openCmdPalette(),
    b: () => {
      const btn = document.getElementById('backlogTabBtn');
      if (btn && btn.style.display !== 'none') switchTab('backlog');else toast('Backlog requires a work-item plugin', 'warning');
    }
  };
  const fn = map[key];
  if (fn) {
    try {
      fn();
    } catch (_) {}
  }
}

// ── Hotkeys: configurable keyboard shortcuts ────────────────────────────────
// Single source of truth for the BINDABLE app shortcuts. run()/when() live in
// code; only the COMBO is user-editable (stored as overrides in
// configData.Hotkeys = { version, bindings: {actionId: combo}, disabled: [] }).
// Menu navigation keys (Enter/Arrow/Escape inside dropdowns), the `g` sequence,
// and the OS panic key are intentionally NOT here.
function _hasWorkItemProvider() {
  return !!(state._loadedPlugins || []).some(p => p.contributions && p.contributions.workItemProvider);
}
const HOTKEY_ACTIONS = [{
  id: 'command-palette',
  group: 'Core',
  label: 'Command palette',
  def: 'Ctrl+K',
  allowInInput: true,
  run: () => openCmdPalette()
}, {
  id: 'command-palette-alt',
  group: 'Core',
  label: 'Command palette (alt)',
  def: 'Ctrl+J',
  allowInInput: true,
  run: () => openCmdPalette()
}, {
  id: 'ai-focus',
  group: 'Core',
  label: 'Ask AI about selection',
  def: 'Ctrl+I',
  allowInInput: true,
  run: () => openAIFocusPalette()
}, {
  id: 'shortcut-help',
  group: 'Core',
  label: 'Keyboard shortcuts help',
  def: 'Ctrl+/',
  allowInInput: true,
  run: () => openShortcutHelp()
}, {
  id: 'rerun-ai',
  group: 'AI',
  label: 'Re-run last AI prompt',
  def: 'Ctrl+.',
  allowInInput: true,
  run: () => {
    const h = _readAiHistory();
    if (h.length) askAIFromPalette(h[0].prompt, {
      forceDispatch: true
    });else toast('No AI history yet', 'info');
  }
}, {
  id: 'go-terminal',
  group: 'Navigate',
  label: 'Go to Terminal',
  def: 'Ctrl+T',
  run: () => switchTab('terminal')
}, {
  id: 'go-backlog',
  group: 'Navigate',
  label: 'Go to Backlog',
  def: 'Ctrl+B',
  when: _hasWorkItemProvider,
  run: () => switchTab('backlog')
}, {
  id: 'go-diffview',
  group: 'Navigate',
  label: 'Go to Diff viewer',
  def: 'Ctrl+D',
  when: () => {
    const b = document.getElementById('diffviewTabBtn');
    return b && b.style.display !== 'none';
  },
  run: () => switchTab('diffview')
}, {
  id: 'refresh-items',
  group: 'Work items',
  label: 'Refresh work items',
  def: 'Ctrl+R',
  when: _hasWorkItemProvider,
  run: () => {
    loadWorkItems(true);
    toast('Refreshed', 'success');
  }
}, {
  id: 'new-item',
  group: 'Work items',
  label: 'New work item',
  def: 'Ctrl+Shift+N',
  allowInInput: true,
  when: _hasWorkItemProvider,
  run: () => openCreateModal()
}, {
  id: 'find-items',
  group: 'Work items',
  label: 'Find work items',
  def: 'Ctrl+Shift+F',
  when: _hasWorkItemProvider,
  run: () => {
    switchTab('backlog');
    setTimeout(() => document.getElementById('backlogSearch')?.focus(), 100);
  }
}, {
  id: 'save-note',
  group: 'Notes',
  label: 'Save note',
  def: 'Ctrl+S',
  allowInInput: true,
  when: () => state.currentNote && document.activeElement === document.getElementById('noteTextarea'),
  run: () => saveCurrentNote()
}, {
  id: 'find-in-note',
  group: 'Notes',
  label: 'Find in note',
  def: 'Ctrl+F',
  allowInInput: true,
  when: () => {
    const p = document.getElementById('panel-notes');
    return p && p.classList.contains('active') && state.currentNote;
  },
  run: () => openNoteFind()
}];
const RESERVED_COMBOS = new Set(['Ctrl+Alt+Shift+X']); // OS panic hotkey (electron-main globalShortcut)

// Canonical combo string from a keydown event, e.g. "Ctrl+Shift+K". Modifier
// order is fixed (Ctrl, Alt, Shift) so record and dispatch always agree. Meta
// is folded into Ctrl. Returns null for a modifier-only press.
function eventToCombo(e) {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta' || k === 'OS') return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = k;
  if (key === ' ') key = 'Space';else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}
function comboToDisplay(combo) {
  return combo;
}
function _hotkeyCfg() {
  const h = typeof state.configData !== 'undefined' && state.configData && state.configData.Hotkeys || {};
  return {
    bindings: h.bindings || {},
    disabled: new Set(h.disabled || [])
  };
}
// Effective combo for an action: undefined binding -> default, '' -> unbound.
function _effCombo(a, bindings) {
  return bindings[a.id] !== undefined ? bindings[a.id] : a.def;
}
state._hotkeyMap = new Map(); // combo -> action (effective, 1:1 via auto-unbind)
function rebuildHotkeyMap() {
  const {
    bindings,
    disabled
  } = _hotkeyCfg();
  state._hotkeyMap = new Map();
  for (const a of HOTKEY_ACTIONS) {
    if (disabled.has(a.id)) continue;
    const combo = _effCombo(a, bindings);
    if (combo) state._hotkeyMap.set(combo, a); // last wins if somehow duplicated
  }
}
// Keep the header command-palette trigger label in sync with the live binding
// (it was a hardcoded "Ctrl+K" that went stale after a rebind).
function syncPaletteShortcutLabel() {
  const a = HOTKEY_ACTIONS.find(x => x.id === 'command-palette');
  if (!a) return;
  const {
    bindings,
    disabled
  } = _hotkeyCfg();
  const combo = disabled.has(a.id) ? '' : _effCombo(a, bindings);
  const kbd = document.getElementById('cmdTriggerKbd');
  const trigger = document.getElementById('cmdTrigger');
  if (kbd) {
    kbd.textContent = combo || '';
    kbd.style.display = combo ? '' : 'none';
  }
  if (trigger) trigger.title = combo ? 'Command Palette (' + combo + ')' : 'Command Palette';
}
function loadHotkeys() {
  rebuildHotkeyMap();
  try {
    syncPaletteShortcutLabel();
  } catch (_) {}
}
rebuildHotkeyMap(); // defaults until loadConfig() applies overrides

// ── Keyboard shortcut hub ───────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    _clearSeq();
  }

  // Don't intercept when typing in inputs/textareas (unless the action opts in)
  const inInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'SELECT';

  // Sequence: first "g" arms, a second key within 1.5s fires the nav.
  if (!inInput && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    if (state._seqPrefix === 'g') {
      const k = e.key.toLowerCase();
      if (/^[a-z]$/.test(k)) {
        e.preventDefault();
        _clearSeq();
        _runSeqKey(k);
        return;
      }
      _clearSeq();
    } else if (e.key === 'g') {
      // Avoid swallowing terminal usage: only arm on an empty window focus.
      state._seqPrefix = 'g';
      state._seqTimer = setTimeout(_clearSeq, 1500);
      return;
    }
  }

  // Configurable hotkeys: look the pressed combo up in the registry dispatch
  // map. Replaces the old hardcoded Ctrl+K/T/B/D/R/... if-chain. Work-item
  // actions gate themselves via their when() (workItemProvider installed).
  const combo = eventToCombo(e);
  if (combo) {
    const action = state._hotkeyMap.get(combo);
    if (action && (action.allowInInput || !inInput)) {
      let ok = true;
      try {
        ok = action.when ? !!action.when() : true;
      } catch (_) {
        ok = false;
      }
      if (ok) {
        e.preventDefault();
        try {
          action.run();
        } catch (_) {}
        return;
      }
    }
  }
});

// ── Hotkeys editor (Settings > Hotkeys) ─────────────────────────────────────
state._hkRecording = null; // actionId currently capturing a new combo
async function saveHotkeys() {
  rebuildHotkeyMap();
  try {
    syncPaletteShortcutLabel();
  } catch (_) {}
  try {
    renderHotkeys();
  } catch (_) {}
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        Hotkeys: state.configData.Hotkeys
      })
    });
  } catch (_) {}
}
function _ensureHotkeysCfg() {
  state.configData.Hotkeys = state.configData.Hotkeys || {
    version: 1,
    bindings: {},
    disabled: []
  };
  state.configData.Hotkeys.bindings = state.configData.Hotkeys.bindings || {};
  if (!Array.isArray(state.configData.Hotkeys.disabled)) state.configData.Hotkeys.disabled = [];
  return state.configData.Hotkeys;
}
function applyHotkeyBinding(actionId, combo) {
  const h = _ensureHotkeysCfg();
  // Auto-unbind: any OTHER action effectively using this combo loses it.
  for (const a of HOTKEY_ACTIONS) {
    if (a.id === actionId) continue;
    if (_effCombo(a, h.bindings) === combo) {
      h.bindings[a.id] = ''; // '' = explicitly unbound
      toast('Unbound "' + a.label + '" from ' + comboToDisplay(combo), 'info');
    }
  }
  h.bindings[actionId] = combo;
  h.disabled = h.disabled.filter(x => x !== actionId); // rebinding re-enables
  saveHotkeys();
}
function startHotkeyRecord(actionId) {
  state._hkRecording = actionId;
  try {
    renderHotkeys();
  } catch (_) {}
  const onKey = e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      state._hkRecording = null;
      cleanup();
      renderHotkeys();
      return;
    }
    const combo = eventToCombo(e);
    if (!combo) return; // modifier-only; keep waiting for the real key
    cleanup();
    state._hkRecording = null;
    if (RESERVED_COMBOS.has(combo)) {
      toast(comboToDisplay(combo) + ' is reserved', 'error');
      renderHotkeys();
      return;
    }
    applyHotkeyBinding(actionId, combo);
  };
  function cleanup() {
    document.removeEventListener('keydown', onKey, true);
  }
  document.addEventListener('keydown', onKey, true); // capture: fire before the hub
}
function resetHotkey(actionId) {
  const h = _ensureHotkeysCfg();
  delete h.bindings[actionId];
  h.disabled = h.disabled.filter(x => x !== actionId);
  saveHotkeys();
}
function toggleHotkeyDisabled(actionId) {
  const h = _ensureHotkeysCfg();
  if (h.disabled.includes(actionId)) h.disabled = h.disabled.filter(x => x !== actionId);else h.disabled.push(actionId);
  saveHotkeys();
}
function resetAllHotkeys() {
  state.configData.Hotkeys = {
    version: 1,
    bindings: {},
    disabled: []
  };
  saveHotkeys();
}
function renderHotkeys() {
  const c = document.getElementById('hotkeysList');
  if (!c) return;
  const {
    bindings,
    disabled
  } = _hotkeyCfg();
  const groups = {};
  for (const a of HOTKEY_ACTIONS) {
    (groups[a.group] = groups[a.group] || []).push(a);
  }
  let html = '<div style="display:flex;justify-content:flex-end;margin-bottom:6px;"><button class="hotkey-mini" onclick="resetAllHotkeys()" title="Reset every shortcut to its default">Reset all</button></div>';
  for (const g of Object.keys(groups)) {
    html += `<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--subtext0);margin:10px 0 2px;">${esc(g)}</div>`;
    for (const a of groups[g]) {
      const combo = _effCombo(a, bindings);
      const isOverridden = bindings[a.id] !== undefined;
      const isDisabled = disabled.has(a.id);
      const recording = state._hkRecording === a.id;
      const chipText = recording ? 'Press keys...' : isDisabled ? '(disabled)' : combo ? esc(comboToDisplay(combo)) : '(unbound)';
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 2px;border-bottom:1px solid var(--surface0);">
        <div style="flex:1;font-size:12px;color:${isDisabled ? 'var(--overlay1)' : 'var(--text)'};">${esc(a.label)}</div>
        <button class="sy-kbd" onclick="startHotkeyRecord('${a.id}')" title="Click, then press a key combo (Esc to cancel)" style="min-width:96px;cursor:pointer;${recording ? 'box-shadow:0 0 0 2px var(--accent);' : ''}">${chipText}</button>
        ${isOverridden ? `<button class="hotkey-mini" onclick="resetHotkey('${a.id}')" title="Reset to default (${esc(a.def)})">Reset</button>` : ''}
        <button class="hotkey-mini" onclick="toggleHotkeyDisabled('${a.id}')" title="${isDisabled ? 'Enable' : 'Disable'}">${isDisabled ? 'Enable' : 'Disable'}</button>
      </div>`;
    }
  }
  c.innerHTML = html;
}// ── Command Palette ─────────────────────────────────────────────────────
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
}// ── Plugin System ──────────────────────────────────────────────────────────

// Notify all plugin iframes of an event
function notifyPluginIframes(eventType, data) {
  document.querySelectorAll('iframe[data-plugin-id]').forEach(function (iframe) {
    try {
      iframe.contentWindow.postMessage({
        __symphonee: true,
        type: eventType,
        data: data
      }, location.origin);
    } catch (_) {}
  });
}

// Listen for postMessage from plugin iframes
window.addEventListener('message', function (event) {
  if (event.origin !== location.origin) return;
  var msg = event.data;
  if (!msg || !msg.__symphonee) return;
  switch (msg.type) {
    case 'switchTab':
      switchTab(msg.tab);
      break;
    case 'askAi':
      askAi(msg.prompt);
      break;
    case 'toast':
      if (typeof toast === 'function') toast(msg.message, msg.level || 'info');
      break;
    case 'getContext':
      var ctxData = {
        activeRepo: state.activeRepo,
        selectedIteration: document.getElementById('sprintSelect').value,
        selectedIterationName: (document.getElementById('sprintSelect').selectedOptions[0] || {}).textContent || '',
        config: {}
      };
      // Send config without secrets
      if (state.configData) {
        var keys = Object.keys(state.configData);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (k.indexOf('PAT') === -1 && k.indexOf('Token') === -1 && k.indexOf('Secret') === -1) {
            ctxData.config[k] = state.configData[k];
          }
        }
      }
      event.source.postMessage({
        __symphonee: true,
        type: 'contextResponse',
        requestId: msg.requestId,
        data: ctxData
      }, event.origin);
      break;
    case 'viewWorkItem':
      viewWorkItem(msg.id);
      break;
    case 'openActivityTimeline':
      openActivityTimeline();
      break;
    case 'viewCommitDiff':
      if (msg.repo) {
        state.filesCurrentRepo = msg.repo;
        state.activeRepo = msg.repo;
      }
      viewCommitDiff(msg.hash);
      break;
    case 'openSettings':
      openSettings(msg.tab || 'plugins');
      if (msg.plugin) {
        setTimeout(function () {
          var btn = document.querySelector('.plugin-settings-nav[data-plugin-tab="ps_' + msg.plugin + '"]');
          if (btn) switchPluginSettingsTab(msg.plugin, btn);
        }, 50);
      }
      break;
    case 'configChanged':
      // Forward config change to all iframes of this plugin so the tab refreshes
      if (msg.plugin) {
        document.querySelectorAll('iframe[data-plugin-id="' + msg.plugin + '"]').forEach(function (f) {
          if (f.contentWindow !== event.source) {
            f.contentWindow.postMessage({
              __symphonee: true,
              type: 'configChanged',
              data: {}
            }, location.origin);
          }
        });
      }
      break;
  }
});

// Execute a plugin action
function executePluginAction(plugin, action) {
  switch (action.type) {
    case 'switchTab':
      var tabId = action.tab;
      if (tabId.indexOf('plugin-') !== 0) tabId = 'plugin-' + plugin.id + '-' + tabId;
      switchTab(tabId);
      break;
    case 'prompt':
      var prompt = action.template.replace(/\$\{repo\}/g, state.activeRepo || '').replace(/\$\{config\.(\w+)\}/g, function (_, key) {
        return (state.configData || {})[key] || '';
      });
      askAi(prompt);
      break;
    case 'api':
      fetch('http://127.0.0.1:3800' + action.path, {
        method: action.method || 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: action.body ? JSON.stringify(action.body) : undefined
      });
      break;
    case 'script':
      var scriptPath = 'dashboard/plugins/' + plugin.id + '/' + action.path;
      var cmd = scriptPath.endsWith('.js') ? 'node ' + scriptPath : scriptPath.endsWith('.ps1') ? 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./' + scriptPath + '"' : './' + scriptPath;
      var aiPrompt = 'Run this command: ' + cmd;
      if (action.analyze) aiPrompt += ' and then ' + action.analyze;
      askAi(aiPrompt);
      break;
  }
}

// Inject a sidebar action button
function injectSidebarAction(plugin, action) {
  var containers = {
    actions: document.getElementById('sidebarPluginActions'),
    aiActions: document.getElementById('sidebarPluginAiActions')
  };
  var container = containers[action.section];
  if (!container) return;
  var btn = document.createElement('button');
  btn.className = 'btn';
  btn.setAttribute('data-plugin-id', plugin.id);
  btn.innerHTML = '<i data-lucide="' + (action.icon || 'puzzle') + '"></i> ' + action.label;
  btn.onclick = function () {
    executePluginAction(plugin, action.action);
  };
  container.appendChild(btn);
}

// Inject an AI action button
function injectAiAction(plugin, action) {
  var container = document.getElementById('sidebarPluginAiActions');
  if (!container) return;
  var btn = document.createElement('button');
  btn.className = 'btn';
  btn.setAttribute('data-plugin-id', plugin.id);
  btn.innerHTML = '<i data-lucide="' + (action.icon || 'sparkles') + '"></i> ' + action.label;
  btn.onclick = function () {
    runPluginAiAction(plugin, action);
  };
  container.appendChild(btn);
}

// Accepts both shapes:
//   v1: {action: {type:'script'|'prompt'|'api'|'switchTab', ...}}
//   v2: {script:'scripts/X.ps1', args?:'...', analyze?:'...', requires?:['sprint']}
//       {prompt:'...'}
//       {command:'globalFunctionName'}
//
// Template variables available in args / analyze / prompt strings:
//   ${sprint}       - raw iteration path from the sidebar sprintSelect ('' if none)
//   ${sprintName}   - human-readable name of the selected iteration
//   ${repo}         - active repo name from /api/ui/context
//   ${repoPath}     - active repo path on disk
//   ${config.X}     - any top-level key from configData
//
// requires: array of context keys that must be non-empty; toasts and bails if any are missing.
function _pluginActionContext() {
  var spEl = document.getElementById('sprintSelect');
  var sprint = spEl ? spEl.value || '' : '';
  var sprintName = spEl && spEl.selectedOptions[0] ? spEl.selectedOptions[0].textContent : '';
  var ctx = typeof state.configData !== 'undefined' && state.configData || {};
  return {
    sprint: sprint,
    sprintName: sprintName,
    repo: (typeof state.activeRepo !== 'undefined' ? state.activeRepo : '') || '',
    repoPath: (ctx.Repos || {})[typeof state.activeRepo !== 'undefined' ? state.activeRepo : ''] || '',
    configData: ctx
  };
}
function _pluginActionSubst(tpl, ctx) {
  if (!tpl) return '';
  return String(tpl).replace(/\$\{sprint\}/g, ctx.sprint).replace(/\$\{sprintName\}/g, ctx.sprintName).replace(/\$\{repo\}/g, ctx.repo).replace(/\$\{repoPath\}/g, ctx.repoPath).replace(/\$\{config\.(\w+)\}/g, function (_, k) {
    return (ctx.configData || {})[k] || '';
  });
}
function runPluginAiAction(plugin, action) {
  if (action.action) return executePluginAction(plugin, action.action);
  var ctx = _pluginActionContext();
  // Enforce requires[] - bail with a toast if any required context is blank.
  var requires = action.requires || [];
  for (var i = 0; i < requires.length; i++) {
    var key = requires[i];
    if (!ctx[key]) {
      var friendly = key === 'sprint' ? 'Select an iteration first' : key === 'repo' ? 'Select a repo first' : 'Missing required context: ' + key;
      toast(friendly, 'info');
      return;
    }
  }
  if (action.script) {
    var scriptPath = 'dashboard/plugins/' + plugin.id + '/' + action.script.replace(/^\/?/, '');
    var args = _pluginActionSubst(action.args || '', ctx);
    var cmd = 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./' + scriptPath + '"' + (args ? ' ' + args : '');
    var prompt = 'Run this command: ' + cmd;
    if (action.analyze) prompt += ' and then ' + _pluginActionSubst(action.analyze, ctx);
    return askAi(prompt);
  }
  if (action.prompt) return askAi(_pluginActionSubst(action.prompt, ctx));
  if (action.command && typeof window[action.command] === 'function') return window[action.command]();
  console.warn('Plugin action has no executable shape:', plugin.id, action);
}

// Inject a custom sidebar section with its own title and buttons
function injectSidebarSection(plugin, section) {
  var container = document.getElementById('sidebarPluginSections');
  if (!container) return;
  var wrapper = document.createElement('div');
  wrapper.setAttribute('data-plugin-id', plugin.id);
  var titleStyle = plugin.tint ? ' style="color: rgba(' + plugin.tint + ', 0.8);"' : '';
  wrapper.innerHTML = '<div class="divider"></div><div class="section-title"' + titleStyle + '>' + (section.title || plugin.name) + '</div>';
  var items = section.items || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var btn = document.createElement('button');
    btn.className = 'btn';
    btn.innerHTML = '<i data-lucide="' + (item.icon || 'puzzle') + '"></i> ' + item.label;
    (function (it) {
      btn.onclick = function () {
        executePluginAction(plugin, it.action);
      };
    })(item);
    wrapper.appendChild(btn);
  }
  container.appendChild(wrapper);
}

// Inject a center tab with iframe panel
function injectCenterTab(plugin, tab) {
  var scrollContainer = document.querySelector('.tab-bar-scroll');
  var tabId = 'plugin-' + plugin.id + '-' + tab.id;
  var btn = document.createElement('button');
  btn.className = 'tab-btn closable';
  btn.dataset.tab = tabId;
  btn.dataset.pluginId = plugin.id;
  btn.setAttribute('data-plugin-id', plugin.id);
  btn.title = tab.label;
  if (plugin.tint) btn.dataset.tint = plugin.tint;

  // Colored dot for plugin identity
  var dot = document.createElement('span');
  dot.className = 'tab-dot';
  dot.style.background = plugin.tint ? 'rgb(' + plugin.tint + ')' : 'var(--accent)';
  btn.appendChild(dot);

  // Full label always shown
  var labelSpan = document.createElement('span');
  labelSpan.textContent = tab.label;
  btn.appendChild(labelSpan);
  var closeSpan = document.createElement('span');
  closeSpan.className = 'tab-close';
  closeSpan.innerHTML = '&#215;';
  closeSpan.onclick = function (e) {
    e.stopPropagation();
    closePluginTab(tabId);
  };
  btn.appendChild(closeSpan);
  btn.onclick = function () {
    switchTab(tabId);
  };
  // Openable plugin tabs slot AFTER the non-openable core tabs (files=900,
  // diffview=901, notes=902). EPHEMERAL_CENTER_BASE = 1000 leaves headroom;
  // we bump a counter so opening two in a row keeps click order.
  injectCenterTab._orderCounter = (injectCenterTab._orderCounter || 0) + 1;
  btn.style.order = String(EPHEMERAL_CENTER_BASE + injectCenterTab._orderCounter);
  scrollContainer.appendChild(btn);
  saveOpenTabs();
  checkTabBarOverflow();
  var panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.id = 'panel-' + tabId;
  panel.setAttribute('data-plugin-id', plugin.id);
  panel.innerHTML = '<iframe src="/plugins/' + plugin.id + '/' + tab.html + '" ' + 'style="width:100%;height:100%;border:none;" ' + 'sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ' + 'data-plugin-id="' + plugin.id + '" data-tab-id="' + tab.id + '"' + (plugin.tint ? ' data-tint="' + plugin.tint + '"' : '') + '></iframe>';
  document.querySelector('.center').appendChild(panel);
}

// Registry of all available plugin center tabs (populated on startup, never injected automatically)
var pluginTabRegistry = [];
function registerPluginTab(plugin, tabDef) {
  // Only openable iframe-backed plugin tabs belong in the '+ Open Tab' menu.
  // Pinned tabs slot in permanently, popup tabs have their own triggers, and
  // claims-based tabs take over a hardcoded built-in slot - none of those are
  // "openable from the menu".
  if (!tabDef || tabDef.pinned || tabDef.popup || tabDef.claims || !tabDef.html) return;
  var tabId = 'plugin-' + plugin.id + '-' + tabDef.id;
  if (!pluginTabRegistry.some(function (r) {
    return r.tabId === tabId;
  })) {
    pluginTabRegistry.push({
      tabId: tabId,
      label: tabDef.label,
      plugin: plugin,
      tabDef: tabDef
    });
  }
}
function isPluginTabOpen(tabId) {
  return !!document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
}
function closePluginTab(tabId) {
  var btn = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
  var panel = document.getElementById('panel-' + tabId);
  var wasActive = btn && btn.classList.contains('active');
  if (btn) btn.remove();
  if (panel) panel.remove();
  if (wasActive) switchTab('terminal');
  saveOpenTabs();
  checkTabBarOverflow();
}

// Scroll arrows for tab bar overflow
function scrollTabs(delta) {
  var el = document.getElementById('tabBarScroll');
  if (el) el.scrollBy({
    left: delta,
    behavior: 'smooth'
  });
}
function updateScrollArrows() {
  var el = document.getElementById('tabBarScroll');
  var left = document.getElementById('tabScrollLeft');
  var right = document.getElementById('tabScrollRight');
  if (!el || !left || !right) return;
  var canScrollLeft = el.scrollLeft > 2;
  var canScrollRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 2;
  left.classList.toggle('visible', canScrollLeft);
  right.classList.toggle('visible', canScrollRight);
}

// Check arrows on scroll, resize, and after tab changes
(function () {
  var el = document.getElementById('tabBarScroll');
  if (el) {
    el.addEventListener('scroll', updateScrollArrows);
    new ResizeObserver(updateScrollArrows).observe(el);
  }
})();
function checkTabBarOverflow() {
  updateScrollArrows();
}

// Plugin-driven shell surfaces. A pinned tab (centerTabs/rightTabs with
// pinned:true and either claims:{tabBtnId,panelId} or html:"...") owns a slot
// in the tab bar at a declared position. Ties break alphabetically by plugin id.
// Ephemeral tabs (no pinned flag) keep the existing "openable from the + menu"
// behavior injected on demand as iframes.
state._intelFallbackToRecipes = false;
function _hasVisibleChildren(el) {
  if (!el) return false;
  return Array.from(el.children).some(function (c) {
    return getComputedStyle(c).display !== 'none';
  });
}
function reconcilePluginShellSurfaces(opts) {
  var pluginDriven = document.getElementById('sidebarPluginDriven');
  var hasLeft = _hasVisibleChildren(document.getElementById('sidebarPluginActions'));
  var hasAi = _hasVisibleChildren(document.getElementById('sidebarPluginAiActions'));
  if (pluginDriven) pluginDriven.style.display = hasLeft || hasAi ? '' : 'none';
  var aiTitle = document.getElementById('sidebarPluginAiTitle');
  var aiDiv = document.getElementById('sidebarPluginAiDivider');
  if (aiTitle) aiTitle.style.display = hasAi ? '' : 'none';
  if (aiDiv) aiDiv.style.display = hasAi && hasLeft ? '' : 'none';
  var leftTitle = document.getElementById('sidebarPluginActionsTitle');
  if (leftTitle) leftTitle.style.display = hasLeft ? '' : 'none';

  // Azure DevOps board picker (sidebar) is shown iff the ADO plugin contributes
  // a workItemProvider. Core does not hardcode the plugin id here.
  var hasProvider = !!(typeof state._loadedPlugins !== 'undefined' && state._loadedPlugins && state._loadedPlugins.some(function (p) {
    return p.contributions && p.contributions.workItemProvider;
  }));
  var adoFixed = document.getElementById('sidebarAdoFixed');
  if (adoFixed) adoFixed.style.display = hasProvider ? '' : 'none';

  // Activity and Team intel tabs are ADO-specific — hide when ADO plugin is absent.
  var activityTab = document.getElementById('intelTab-activity');
  var teamTab = document.getElementById('intelTab-team');
  if (activityTab) activityTab.style.display = hasProvider ? '' : 'none';
  if (teamTab) teamTab.style.display = hasProvider ? '' : 'none';
  // If Activity was the active intel tab and is now hidden, fall back to Git Log.
  if (!hasProvider && activityTab && activityTab.classList.contains('active')) {
    var gitLogTab = document.getElementById('intelTab-gitlog');
    if (gitLogTab && typeof switchIntelTab === 'function') switchIntelTab('gitlog');
  }
  applyPluginPinnedTabs(opts);

  // Repaint any visible "Clone from X" button rows from repoSources contributions.
  try {
    renderCloneSourceButtons('settingsRepoAddBtns', 'settings', 'modal-btn');
  } catch (_) {}
  try {
    renderCloneSourceButtons('obRepoAddBtns', 'ob', 'onboarding-btn onboarding-btn-primary');
  } catch (_) {}
}

// Core pinned tabs: hardcoded positions so plugin tabs can slot around them.
// Diff is core but behaves like a popup (hidden until showFile/showDiff opens
// it, closable from the X). It slots right after Files.
var CORE_PINNED_CENTER = {
  terminal: 0,
  orchestrator: 1,
  browser: 2,
  apps: 3,
  files: 900,
  diffview: 901,
  notes: 902
};
// Core right-column (intel) tabs. Recipes is always pinned last on the right.
var CORE_PINNED_RIGHT = {
  recipes: 900
};
var EPHEMERAL_CENTER_BASE = 1000;

// Collect every pinned + popup tab from all active plugins. Both kinds slot
// at a declared position and are handled by applyPluginPinnedTabs; the
// difference is visibility (pinned shows immediately, popup waits for a trigger).
function _collectPinnedTabs(kind) {
  var out = [];
  if (typeof state._loadedPlugins === 'undefined' || !state._loadedPlugins) return out;
  for (var i = 0; i < state._loadedPlugins.length; i++) {
    var p = state._loadedPlugins[i];
    var list = (p.contributions || {})[kind] || [];
    list.forEach(function (t, idx) {
      if (!t || !t.pinned && !t.popup) return;
      out.push({
        plugin: p,
        tab: t,
        position: typeof t.position === 'number' ? t.position : 2 + idx
      });
    });
  }
  // Sort by position, alphabetical tie-break on plugin id + tab id.
  out.sort(function (a, b) {
    if (a.position !== b.position) return a.position - b.position;
    var aKey = a.plugin.id + ':' + a.tab.id;
    var bKey = b.plugin.id + ':' + b.tab.id;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return out;
}
function applyPluginPinnedTabs(opts) {
  opts = opts || {};

  // User-saved drag-reorder overrides win over declared defaults.
  var _savedOrder = typeof getSavedTabOrderOverrides === 'function' ? getSavedTabOrderOverrides() : {};

  // Give core tabs their declared order so they don't fight plugin positions.
  Object.keys(CORE_PINNED_CENTER).forEach(function (dataTab) {
    var el = document.querySelector('.tab-bar-scroll .tab-btn[data-tab="' + dataTab + '"]');
    if (!el) return;
    if (Object.prototype.hasOwnProperty.call(_savedOrder, dataTab)) {
      el.style.order = String(_savedOrder[dataTab]);
    } else {
      el.style.order = String(CORE_PINNED_CENTER[dataTab]);
    }
  });
  Object.keys(CORE_PINNED_RIGHT).forEach(function (dataTab) {
    var el = document.querySelector('.intel-tabs .intel-tab[data-itab="' + dataTab + '"]');
    if (el) el.style.order = String(CORE_PINNED_RIGHT[dataTab]);
  });
  // Keep the "+ open closed panels" wrap pinned to the very end of the row.
  var _reopen = document.getElementById('intelReopenWrap');
  if (_reopen) _reopen.style.order = '9999';

  // Reset all claimable core tab buttons to hidden. A plugin claim re-shows them.
  var centerCandidates = ['backlogTabBtn', 'workitemTabBtn', 'prsTabBtn', 'activityTabBtn'];
  centerCandidates.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  ['intelTab-activity', 'intelTab-team', 'intelTab-gitlog'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Fold pinned + popup plugin tabs into the DOM. Position is applied as a flex
  // `order`. Pinned tabs are revealed; popup tabs stay hidden until plugin code
  // calls openPopupTab(tabBtnId) and gain a close X via _ensureTabCloseButton.
  _collectPinnedTabs('centerTabs').forEach(function (entry) {
    var tab = entry.tab;
    if (tab.claims && tab.claims.tabBtnId) {
      var el = document.getElementById(tab.claims.tabBtnId);
      if (!el) return;
      var _claimKey = el.dataset && el.dataset.tab;
      if (_claimKey && Object.prototype.hasOwnProperty.call(_savedOrder, _claimKey)) {
        el.style.order = String(_savedOrder[_claimKey]);
      } else {
        el.style.order = String(entry.position);
      }
      if (tab.popup) {
        // Popup tabs always start hidden; plugin code reveals them on demand
        // (e.g. viewWorkItem). Closing happens via the panel's own close
        // affordance - the tab itself does not get an X.
        el.style.display = 'none';
      } else {
        el.style.removeProperty('display');
        el.removeAttribute('hidden');
      }
    } else if (tab.html) {
      injectPinnedCenterTab(entry.plugin, tab, entry.position);
    }
  });
  _collectPinnedTabs('rightTabs').forEach(function (entry) {
    var tab = entry.tab;
    if (tab.claims && tab.claims.tabBtnId) {
      var el = document.getElementById(tab.claims.tabBtnId);
      if (!el) return;
      el.style.order = String(entry.position);
      if (tab.popup) {
        el.style.display = 'none';
      } else {
        el.style.removeProperty('display');
        el.removeAttribute('hidden');
      }
    } else if (tab.html) {
      injectPinnedIntelPanel(entry.plugin, tab, entry.position);
    }
  });

  // If the currently active intel tab is hidden (or we are forcing the activity
  // default), pick the visible intel tab with the lowest CSS `order` so the
  // leftmost tab on the right column becomes the default.
  function _intelTabHidden(el) {
    if (!el) return true;
    if (el.style.display === 'none' || el.hasAttribute('hidden')) return true;
    if (el.classList && el.classList.contains('plugin-space-hidden')) return true;
    try {
      var cs = getComputedStyle(el);
      if (cs && cs.display === 'none') return true;
    } catch (_) {}
    return false;
  }
  function _firstVisibleIntelTab() {
    var all = Array.prototype.slice.call(document.querySelectorAll('.intel-tab'));
    var visible = all.filter(function (el) {
      if (!el.dataset.itab) return false;
      return !_intelTabHidden(el);
    });
    // Git Log stays useful only when a repo is active; prefer Recipes otherwise.
    if (!state.activeRepo) {
      var recipes = visible.filter(function (el) {
        return el.dataset.itab === 'recipes';
      });
      if (recipes.length) return recipes[0];
    }
    visible.sort(function (a, b) {
      var ao = parseFloat(a.style.order || getComputedStyle(a).order || '0') || 0;
      var bo = parseFloat(b.style.order || getComputedStyle(b).order || '0') || 0;
      return ao - bo;
    });
    return visible[0] || null;
  }
  var activeIntel = document.querySelector('.intel-tab.active');
  // Restore the user's last-selected right-panel tab if it's currently visible
  // (persisted by switchIntelTab). Takes priority over the DOM default so the
  // panel reopens where the user left it across restarts.
  var savedIntel = null;
  try {
    savedIntel = localStorage.getItem('symphonee-intel-tab');
  } catch (_) {}
  var savedBtn = null;
  if (savedIntel) {
    try {
      savedBtn = document.querySelector('.intel-tab[data-itab="' + savedIntel.replace(/["\\\]]/g, '') + '"]');
    } catch (_) {}
  }
  var needFallback = !activeIntel || _intelTabHidden(activeIntel) || opts.preferActivityDefault && activeIntel.dataset.itab === 'recipes';
  if (savedBtn && !_intelTabHidden(savedBtn) && (!activeIntel || activeIntel.dataset.itab !== savedIntel)) {
    state._intelFallbackToRecipes = savedIntel === 'recipes';
    try {
      switchIntelTab(savedIntel);
    } catch (_) {}
  } else if (needFallback) {
    var first = _firstVisibleIntelTab();
    if (first && first.dataset.itab) {
      state._intelFallbackToRecipes = first.dataset.itab === 'recipes';
      try {
        switchIntelTab(first.dataset.itab);
      } catch (_) {}
    }
  } else {
    state._intelFallbackToRecipes = false;
  }

  // Rebuild pluginTabRegistry's DOM-claiming entries so the '+' menu reflects
  // openable claimed tabs. Iframe-backed pinned tabs are already in the DOM.
  try {
    if (typeof pluginTabRegistry !== 'undefined') {
      for (var k = pluginTabRegistry.length - 1; k >= 0; k--) {
        if (pluginTabRegistry[k]._native) pluginTabRegistry.splice(k, 1);
      }
      _collectPinnedTabs('centerTabs').forEach(function (entry) {
        var tab = entry.tab;
        // Only claims-based, ephemeral tabs belong here. Pinned tabs are already
        // a permanent slot (no + menu entry needed) and popup tabs have their
        // own triggers (viewWorkItem, openActivityTimeline, etc.).
        if (!tab.claims || tab.pinned || tab.popup) return;
        var btn = document.getElementById(tab.claims.tabBtnId);
        if (!btn) return;
        pluginTabRegistry.push({
          _native: true,
          plugin: entry.plugin,
          label: tab.label || (btn.textContent || tab.claims.tabBtnId).trim(),
          tabId: btn.getAttribute('data-tab') || tab.claims.tabBtnId,
          tabDef: null
        });
      });
    }
  } catch (_) {}
}

// Reveal a popup tab and switch to it. Plugin code (e.g. viewWorkItem,
// openActivityTimeline) should call this instead of poking display directly so
// the tab respects its declared position.
function openPopupTab(tabBtnId) {
  var el = document.getElementById(tabBtnId);
  if (!el) return;
  el.style.removeProperty('display');
  el.removeAttribute('hidden');
  var dataTab = el.getAttribute('data-tab') || tabBtnId;
  switchTab(dataTab);
}

// Hide a popup tab's button. If it was the active tab, switch back to terminal.
function closePopupTab(tabBtnId) {
  var el = document.getElementById(tabBtnId);
  if (!el) return;
  var wasActive = el.classList.contains('active');
  el.style.display = 'none';
  if (wasActive) switchTab('terminal');
}

// Inject an iframe-backed pinned center tab at a declared position. Idempotent.
function injectPinnedCenterTab(plugin, tab, position) {
  var scrollContainer = document.querySelector('.tab-bar-scroll');
  var tabId = 'plugin-' + plugin.id + '-' + tab.id;
  var _overrides = typeof getSavedTabOrderOverrides === 'function' ? getSavedTabOrderOverrides() : {};
  var _effectiveOrder = Object.prototype.hasOwnProperty.call(_overrides, tabId) ? _overrides[tabId] : position;
  var existing = scrollContainer.querySelector('.tab-btn[data-tab="' + tabId + '"]');
  if (existing) {
    existing.style.order = String(_effectiveOrder);
    return;
  }
  var btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.tab = tabId;
  btn.dataset.pluginId = plugin.id;
  btn.style.order = String(_effectiveOrder);
  if (plugin.tint) btn.dataset.tint = plugin.tint;
  var dot = document.createElement('span');
  dot.className = 'tab-dot';
  dot.style.background = plugin.tint ? 'rgb(' + plugin.tint + ')' : 'var(--accent)';
  btn.appendChild(dot);
  var labelSpan = document.createElement('span');
  labelSpan.textContent = tab.label;
  btn.appendChild(labelSpan);
  btn.onclick = function () {
    switchTab(tabId);
  };
  scrollContainer.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.id = 'panel-' + tabId;
  panel.setAttribute('data-plugin-id', plugin.id);
  panel.innerHTML = '<iframe src="/plugins/' + plugin.id + '/' + tab.html + '" ' + 'style="width:100%;height:100%;border:none;" ' + 'sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ' + 'data-plugin-id="' + plugin.id + '" data-tab-id="' + tab.id + '"' + (plugin.tint ? ' data-tint="' + plugin.tint + '"' : '') + '></iframe>';
  document.querySelector('.center').appendChild(panel);
}
function injectPinnedIntelPanel(plugin, tab, position) {
  var tabBar = document.querySelector('.intel-tabs');
  var panelId = 'plugin-' + plugin.id + '-' + tab.id;
  var existing = tabBar.querySelector('.intel-tab[data-itab="' + panelId + '"]');
  if (existing) {
    existing.style.order = String(position);
    return;
  }
  var btn = document.createElement('button');
  btn.className = 'intel-tab';
  btn.dataset.itab = panelId;
  btn.dataset.pluginId = plugin.id;
  btn.style.order = String(position);
  if (plugin.tint) btn.dataset.tint = plugin.tint;
  btn.appendChild(document.createTextNode(tab.label));
  btn.onclick = function () {
    switchIntelTab(panelId);
  };
  tabBar.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'intel-panel';
  panel.id = 'ipanel-' + panelId;
  panel.innerHTML = '<iframe src="/plugins/' + plugin.id + '/' + tab.html + '" ' + 'style="width:100%;height:100%;border:none;" ' + 'sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ' + 'data-plugin-id="' + plugin.id + '" data-tab-id="' + tab.id + '"' + (plugin.tint ? ' data-tint="' + plugin.tint + '"' : '') + '></iframe>';
  document.querySelector('.intel').appendChild(panel);
}

// Open a plugin tab by tabId (injects it if not already open, then switches to it)
function openPluginTab(tabId) {
  if (isPluginTabOpen(tabId)) {
    _pinPluginTabToEnd(tabId);
    switchTab(tabId);
    return;
  }
  var entry = pluginTabRegistry.find(function (r) {
    return r.tabId === tabId;
  });
  if (entry && entry._native) {
    // Native tabs are already in the DOM; just show the button (if hidden) and activate it.
    var btn = document.getElementById(tabId + 'TabBtn') || document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
    if (btn) btn.style.display = '';
    _pinPluginTabToEnd(tabId);
    switchTab(tabId);
    return;
  }
  if (entry) {
    injectCenterTab(entry.plugin, entry.tabDef);
    _pinPluginTabToEnd(tabId);
    switchTab(tabId);
  }
}

// Force a plugin tab to the very end of the tab row whenever it's opened.
// Writes both the live style.order AND the persisted override so drag-reorder
// state from a prior session can't pull it back into the middle.
function _pinPluginTabToEnd(tabId) {
  try {
    var scroll = document.getElementById('tabBarScroll');
    if (!scroll) return;
    var saved = typeof getSavedTabOrderOverrides === 'function' ? getSavedTabOrderOverrides() : {};
    var highest = 0;
    scroll.querySelectorAll('.tab-btn').forEach(function (el) {
      var key = el.dataset && el.dataset.tab;
      if (!key || key === tabId) return;
      var o = parseFloat(saved[key]);
      if (!isFinite(o)) o = parseFloat(el.style.order);
      if (isFinite(o) && o > highest) highest = o;
    });
    var next = Math.max(20000, Math.floor(highest) + 1);
    saved[tabId] = next;
    try {
      localStorage.setItem('symphonee-tab-order-v2', JSON.stringify(saved));
    } catch (_) {}
    var btn = document.getElementById(tabId + 'TabBtn') || document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
    if (btn) btn.style.order = String(next);
  } catch (_) {}
}

// Open a plugin's first center tab by plugin ID (used by view-plugin, command palette, AI)
function ensurePluginTabOpen(pluginId) {
  var tabPrefix = 'plugin-' + pluginId + '-';
  // Already open? Just switch.
  var existing = document.querySelector('.tab-btn[data-tab^="' + tabPrefix + '"]');
  if (existing) {
    switchTab(existing.dataset.tab);
    return existing.dataset.tab;
  }
  // Find in registry and open the first tab for this plugin
  var entry = pluginTabRegistry.find(function (r) {
    return r.tabId.indexOf(tabPrefix) === 0;
  });
  if (entry) {
    injectCenterTab(entry.plugin, entry.tabDef);
    switchTab(entry.tabId);
    return entry.tabId;
  }
  return null;
}
function toggleOpenTabMenu() {
  var menu = document.getElementById('tabOpenMenu');
  var isOpen = menu.classList.contains('open');
  menu.classList.toggle('open', !isOpen);
  if (!isOpen) {
    menu.innerHTML = '';
    // Gather the active space's plugin preset so we filter out plugins the
    // user hasn't surfaced for this space. Empty preset / no space = no filter.
    var allowed = null;
    try {
      if (state.activeSpace && window._spacesCache) {
        var preset = window._spacesCache[state.activeSpace] && window._spacesCache[state.activeSpace].plugins;
        if (Array.isArray(preset)) preset = preset.filter(function (id) {
          return !isCoreSpacePluginId(id);
        });
        if (Array.isArray(preset) && preset.length) {
          allowed = new Set(preset);
          CORE_SPACE_PLUGIN_IDS.forEach(function (id) {
            allowed.add(id);
          });
        }
      }
    } catch (_) {}
    for (var i = 0; i < pluginTabRegistry.length; i++) {
      (function (entry) {
        if (allowed && !allowed.has(entry.plugin.id)) return;
        var open = isPluginTabOpen(entry.tabId);
        var item = document.createElement('button');
        item.className = 'tab-open-item';
        var dot = document.createElement('span');
        dot.className = 'tab-open-dot';
        dot.style.background = entry.plugin.tint ? 'rgb(' + entry.plugin.tint + ')' : 'var(--accent)';
        item.appendChild(dot);
        var lbl = document.createElement('span');
        lbl.textContent = entry.label;
        item.appendChild(lbl);
        if (open) {
          var check = document.createElement('span');
          check.className = 'tab-open-check';
          check.textContent = 'open';
          item.appendChild(check);
        }
        item.onclick = function () {
          if (open) {
            switchTab(entry.tabId);
          } else {
            openPluginTab(entry.tabId);
          }
          menu.classList.remove('open');
        };
        menu.appendChild(item);
      })(pluginTabRegistry[i]);
    }
    if (pluginTabRegistry.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'padding:10px 14px;font-size:12px;color:var(--subtext0);';
      empty.textContent = 'No plugins installed';
      menu.appendChild(empty);
    }
  }
}
document.addEventListener('click', function (e) {
  var menu = document.getElementById('tabOpenMenu');
  var wrap = document.getElementById('tabOpenWrap');
  if (menu && wrap && !wrap.contains(e.target)) menu.classList.remove('open');
});

// - Persist open plugin tabs in localStorage ---------------------------------
function saveOpenTabs() {
  var open = [];
  document.querySelectorAll('.tab-btn.closable').forEach(function (btn) {
    if (btn.dataset.tab) open.push(btn.dataset.tab);
  });
  try {
    localStorage.setItem('symphonee-open-tabs', JSON.stringify(open));
  } catch (_) {}
}
function restoreOpenTabs() {
  try {
    var saved = JSON.parse(localStorage.getItem('symphonee-open-tabs') || '[]');
    for (var i = 0; i < saved.length; i++) {
      var tabId = saved[i];
      if (!isPluginTabOpen(tabId)) {
        var entry = pluginTabRegistry.find(function (r) {
          return r.tabId === tabId;
        });
        if (entry) injectCenterTab(entry.plugin, entry.tabDef);
      }
    }
  } catch (_) {}
  checkTabBarOverflow();
}

// Inject a right-side intel panel with iframe
function injectIntelPanel(plugin, ip) {
  var tabBar = document.querySelector('.intel-tabs');
  var panelId = 'plugin-' + plugin.id + '-' + ip.id;
  var btn = document.createElement('button');
  btn.className = 'intel-tab closable';
  btn.dataset.itab = panelId;
  btn.dataset.pluginId = plugin.id;
  btn.setAttribute('data-plugin-id', plugin.id);
  if (plugin.tint) btn.dataset.tint = plugin.tint;
  var label = document.createTextNode(ip.label);
  btn.appendChild(label);
  var closeSpan = document.createElement('span');
  closeSpan.className = 'tab-close';
  closeSpan.innerHTML = '&#215;';
  closeSpan.onclick = function (e) {
    e.stopPropagation();
    closeIntelPanel(panelId);
  };
  btn.appendChild(closeSpan);
  btn.onclick = function () {
    switchIntelTab(panelId);
  };
  tabBar.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'intel-panel';
  panel.id = 'ipanel-' + panelId;
  panel.setAttribute('data-plugin-id', plugin.id);
  panel.innerHTML = '<iframe src="/plugins/' + plugin.id + '/' + ip.html + '" ' + 'style="width:100%;height:100%;border:none;" ' + 'sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ' + 'data-plugin-id="' + plugin.id + '" data-tab-id="' + ip.id + '"' + (plugin.tint ? ' data-tint="' + plugin.tint + '"' : '') + '></iframe>';
  document.querySelector('.intel').appendChild(panel);
}
state.closedIntelPanels = [];
function closeIntelPanel(panelId) {
  var btn = document.querySelector('.intel-tab[data-itab="' + panelId + '"]');
  var panel = document.getElementById('ipanel-' + panelId);
  var wasActive = btn && btn.classList.contains('active');
  var pluginId = btn ? btn.dataset.pluginId : null;
  if (pluginId) {
    var plugin = state._loadedPlugins.find(function (p) {
      return p.id === pluginId;
    });
    if (plugin && plugin.contributions && (plugin.contributions.rightTabs || plugin.contributions.intelPanels)) {
      var rightDefs = plugin.contributions.rightTabs || plugin.contributions.intelPanels || [];
      var ipDef = rightDefs.find(function (ip) {
        return 'plugin-' + pluginId + '-' + ip.id === panelId;
      });
      if (ipDef && !state.closedIntelPanels.some(function (c) {
        return c.panelId === panelId;
      })) {
        state.closedIntelPanels.push({
          panelId: panelId,
          label: ipDef.label,
          plugin: plugin,
          ipDef: ipDef
        });
      }
    }
  }
  if (btn) btn.remove();
  if (panel) panel.remove();
  if (wasActive) {
    var activity = document.getElementById('intelTab-activity');
    switchIntelTab(activity && activity.style.display !== 'none' ? 'activity' : 'recipes');
  }
  updateIntelReopenButton();
}
function updateIntelReopenButton() {
  var wrap = document.getElementById('intelReopenWrap');
  if (wrap) wrap.style.display = state.closedIntelPanels.length > 0 ? 'inline-block' : 'none';
}
function toggleIntelReopenMenu() {
  var menu = document.getElementById('intelReopenMenu');
  var isOpen = menu.classList.contains('open');
  menu.classList.toggle('open', !isOpen);
  if (!isOpen) {
    menu.innerHTML = '';
    for (var i = 0; i < state.closedIntelPanels.length; i++) {
      (function (entry) {
        var item = document.createElement('button');
        item.className = 'tab-open-item';
        item.textContent = entry.label;
        item.onclick = function () {
          injectIntelPanel(entry.plugin, entry.ipDef);
          state.closedIntelPanels = state.closedIntelPanels.filter(function (c) {
            return c.panelId !== entry.panelId;
          });
          updateIntelReopenButton();
          switchIntelTab(entry.panelId);
          menu.classList.remove('open');
        };
        menu.appendChild(item);
      })(state.closedIntelPanels[i]);
    }
  }
}
document.addEventListener('click', function (e) {
  var menu = document.getElementById('intelReopenMenu');
  var wrap = document.getElementById('intelReopenWrap');
  if (menu && wrap && !wrap.contains(e.target)) menu.classList.remove('open');
});

// Store context menu items for later use
var pluginContextMenuItems = [];
function registerContextMenuItem(plugin, item) {
  pluginContextMenuItems.push({
    plugin: plugin,
    item: item
  });
}

// Initialize all plugins on load. `_pluginsReady` resolves when the IIFE has
// fetched /api/plugins and finished injecting contributions - other async
// startup code (loadConfig, applyPluginPinnedTabs) should await this before
// assuming _loadedPlugins reflects reality.
state._loadedPlugins = [];
state._pluginsReadyResolve = undefined;
var _pluginsReady = new Promise(function (r) {
  state._pluginsReadyResolve = r;
});

// Re-fetch /api/plugins and figure out which plugins changed activation state
// since the last call. Returns { added, removed } so the caller can decide
// whether a restart is needed (e.g. if a removed plugin was driving tabs).
async function refreshPluginActivation() {
  try {
    var res = await fetch('/api/plugins', {
      cache: 'no-store'
    });
    var next = await res.json();
    var prevIds = new Set(state._loadedPlugins.map(function (p) {
      return p.id;
    }));
    var nextIds = new Set(next.map(function (p) {
      return p.id;
    }));
    var added = next.filter(function (p) {
      return !prevIds.has(p.id);
    });
    var removed = state._loadedPlugins.filter(function (p) {
      return !nextIds.has(p.id);
    });
    state._loadedPlugins = next;
    return {
      added: added,
      removed: removed
    };
  } catch (e) {
    console.warn('refreshPluginActivation failed', e);
    return {
      added: [],
      removed: []
    };
  }
}
(async function initPlugins() {
  var plugins = [];
  var __initPluginsStart = Date.now();
  try {
    var res = await fetch('/api/plugins');
    plugins = await res.json();
    console.info('[initPlugins] fetched', plugins.length, 'plugins in', Date.now() - __initPluginsStart + 'ms', '->', plugins.map(function (p) {
      return p.id;
    }).join(','));
  } catch (e) {
    console.warn('[initPlugins] fetch failed:', e && e.message);
    try {
      if (typeof state._pluginsReadyResolve === 'function') state._pluginsReadyResolve();
    } catch (_) {}
    return;
  }
  state._loadedPlugins = plugins;

  // Always show Plugins tab in settings so users can browse/install plugins
  document.getElementById('settingsPluginsBtn').style.display = '';
  if (plugins.length) {
    for (var i = 0; i < plugins.length; i++) {
      var p = plugins[i];
      var c = p.contributions || {};
      if (c.sidebarActions) c.sidebarActions.forEach(function (a) {
        injectSidebarAction(p, a);
      });
      if (c.leftQuickActions) c.leftQuickActions.forEach(function (a) {
        // v2 shape: {id, label, icon, command} OR {id, label, icon, script, analyze}
        var container = document.getElementById('sidebarPluginActions');
        if (!container) return;
        var btn = document.createElement('button');
        btn.className = 'btn';
        btn.setAttribute('data-plugin-id', p.id);
        btn.innerHTML = '<i data-lucide="' + (a.icon || 'puzzle') + '"></i> ' + a.label;
        btn.onclick = function () {
          runPluginAiAction(p, a);
        };
        container.appendChild(btn);
      });
      if (c.aiActions) c.aiActions.forEach(function (a) {
        injectAiAction(p, a);
      });
      if (c.sidebarSections) c.sidebarSections.forEach(function (s) {
        injectSidebarSection(p, s);
      });
      // Pinned tabs (claims-based or html-based) are placed by applyPluginPinnedTabs
      // when loadConfig calls reconcilePluginShellSurfaces. Ephemeral tabs land in
      // the registry so the user can open them from the + menu.
      if (c.centerTabs) c.centerTabs.forEach(function (t) {
        if (!t.pinned) registerPluginTab(p, t);
      });
      if (c.rightTabs) c.rightTabs.forEach(function (ip) {
        if (!ip.pinned) injectIntelPanel(p, ip);
      });
      if (c.intelPanels) c.intelPanels.forEach(function (ip) {
        injectIntelPanel(p, ip);
      });
      if (c.contextMenuItems) c.contextMenuItems.forEach(function (m) {
        registerContextMenuItem(p, m);
      });
    }

    // Restore previously open plugin tabs from localStorage
    restoreOpenTabs();
  }

  // Settings > Plugins should list every installed plugin (active + inactive)
  // so users can configure an installed-but-unconfigured plugin before its
  // routes activate. Must run even when /api/plugins returned zero active
  // plugins - that is exactly the "fresh install with only unconfigured
  // first-party plugins" case. /api/plugins/installed returns both kinds with
  // an `active` flag; fall back to the active list if the endpoint is missing.
  try {
    var installedRes = await fetch('/api/plugins/installed', {
      cache: 'no-store'
    });
    var installed = installedRes.ok ? await installedRes.json() : plugins;
    renderPluginSettings(installed);
  } catch (_) {
    renderPluginSettings(plugins);
  }
  lucide.createIcons();

  // Load plugin items for command palette (async, non-blocking)
  loadPluginCmdItems();

  // Signal readiness so loadConfig()'s post-step can safely re-run
  // applyPluginPinnedTabs against the now-populated _loadedPlugins.
  try {
    if (typeof state._pluginsReadyResolve === 'function') state._pluginsReadyResolve();
  } catch (_) {}

  // Apply any space-based plugin preset after the DOM is populated.
  try {
    applyPluginSpaceFilter();
  } catch (_) {}
})();

// Render plugin settings fields in the Settings > Plugins tab
function renderPluginSettings(plugins) {
  var container = document.getElementById('pluginSettingsContainer');
  void refreshSpecialSettingsPanels(plugins);
  // Hide plugins whose settings live on purpose-built settings tabs instead of
  // the generic Plugins list.
  var SPECIAL_SETTINGS_PLUGIN_IDS = {
    'stagehand': true,
    'browser-use': true,
    'video-use': true
  };
  plugins = (plugins || []).filter(function (p) {
    return p && !SPECIAL_SETTINGS_PLUGIN_IDS[p.id];
  });
  if (!plugins.length) {
    container.innerHTML = '<div style="color:var(--subtext0);padding:12px;">No plugins installed.</div>';
    return;
  }

  // Vertical nav column + settings panel (matching main settings pattern)
  var nav = '<div style="display:flex;gap:0;height:100%;">';
  nav += '<div style="min-width:140px;border-right:1px solid var(--surface0);padding:8px 0;display:flex;flex-direction:column;gap:2px;">';
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    var active = i === 0 ? ' active' : '';
    var tintStyle = p.tint ? 'border-left:2px solid rgba(' + p.tint + ',0.5);' : '';
    nav += '<button class="settings-nav-btn plugin-settings-nav' + active + '" data-plugin-tab="ps_' + p.id + '" onclick="switchPluginSettingsTab(\'' + p.id + '\',this)" style="text-align:left;padding:8px 14px;font-size:12px;border-radius:0;' + tintStyle + '">' + '<i data-lucide="' + (p.icon || 'puzzle') + '" style="width:14px;height:14px;"></i> ' + (p.name || p.id) + '</button>';
  }
  nav += '</div><div style="flex:1;padding:16px;overflow-y:auto;">';

  // Panels
  for (var i = 0; i < plugins.length; i++) {
    var p = plugins[i];
    nav += '<div class="plugin-settings-panel" id="ps_' + p.id + '" style="' + (i === 0 ? '' : 'display:none;') + '">';
    nav += '<div class="settings-section-title">' + (p.name || p.id) + '</div>';
    if (p.description) nav += '<div class="settings-section-desc" style="margin-bottom:16px;">' + p.description + '</div>';
    var settings = p.settings || [];
    var hasNativeSettings = p.contributions && p.contributions.nativeSettings && p.contributions.nativeSettings.targetId;
    var hasSettingsHtml = p.contributions && p.contributions.settingsHtml;
    if (hasNativeSettings) {
      nav += '<div class="plugin-native-settings-mount" data-target-id="' + p.contributions.nativeSettings.targetId + '"' + (p.contributions.nativeSettings.hideNavSelector ? ' data-hide-nav="' + p.contributions.nativeSettings.hideNavSelector + '"' : '') + '></div>';
    } else if (hasSettingsHtml) {
      nav += '<iframe src="/plugins/' + p.id + '/' + p.contributions.settingsHtml + '" ' + 'style="width:100%;min-height:320px;border:none;" ' + 'sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ' + 'data-plugin-id="' + p.id + '"' + (p.tint ? ' data-tint="' + p.tint + '"' : '') + ' onload="this.style.height=Math.max(320,this.contentDocument.body.scrollHeight+24)+\'px\'"' + '></iframe>';
    } else if (!settings.length) {
      nav += '<div style="font-size:12px;color:var(--subtext0);">No configurable settings.</div>';
    }
    for (var j = 0; j < settings.length; j++) {
      var s = settings[j];
      var fieldId = 'pluginSetting_' + p.id + '_' + s.key;
      var isSecret = !!(s.secret || s.sensitive);
      nav += '<div class="modal-field">';
      nav += '<label>' + (s.label || s.key) + '</label>';
      if (s.description) nav += '<div style="font-size:11px;color:var(--subtext0);margin-bottom:4px;">' + s.description + '</div>';
      if (isSecret) {
        nav += '<div style="display:flex;gap:0;">';
        nav += '<input id="' + fieldId + '" type="password" placeholder="' + (s.placeholder || '') + '" data-plugin="' + p.id + '" data-key="' + s.key + '" class="plugin-setting-input" style="border-radius:var(--radius) 0 0 var(--radius);flex:1;">';
        nav += '<button type="button" onclick="toggleSecretField(\'' + fieldId + '\',this)" style="background:var(--surface0);border:1px solid var(--surface1);border-left:none;border-radius:0 var(--radius) var(--radius) 0;padding:0 10px;cursor:pointer;color:var(--subtext0);display:flex;align-items:center;" title="Show/hide"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button>';
        nav += '</div>';
      } else if (s.type === 'select' || s.optionsFrom) {
        var hint = s.optionsFrom === 'aiModels' ? 'Selects the default AI when not set. Only models for which you have an API key in Settings -> AI Keys appear here.' : s.hint || '';
        if (hint) nav += '<div style="font-size:11px;color:var(--subtext0);margin-bottom:4px;font-style:italic;">' + hint + '</div>';
        nav += '<select id="' + fieldId + '" data-plugin="' + p.id + '" data-key="' + s.key + '"' + (s.optionsFrom ? ' data-options-from="' + s.optionsFrom + '"' : '') + ' class="plugin-setting-input"></select>';
      } else if (s.type === 'boolean') {
        nav += '<label class="plugin-setting-toggle" style="display:inline-flex;align-items:center;gap:10px;cursor:pointer;user-select:none;">';
        nav += '<span class="sy-switch"><input id="' + fieldId + '" type="checkbox" data-plugin="' + p.id + '" data-key="' + s.key + '" class="plugin-setting-input plugin-setting-bool"><span class="plugin-setting-track"></span></span>';
        nav += '<span style="font-size:12px;color:var(--subtext0);" data-toggle-label="off">Off</span>';
        nav += '</label>';
      } else {
        nav += '<input id="' + fieldId + '" type="text" placeholder="' + (s.placeholder || '') + '" data-plugin="' + p.id + '" data-key="' + s.key + '" class="plugin-setting-input">';
      }
      nav += '</div>';
    }
    // Delete button
    nav += '<div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--surface0);">';
    nav += '<button class="btn" style="color:var(--red);border-color:var(--red);font-size:11px;" onclick="uninstallPlugin(\'' + p.id + '\',\'' + (p.name || p.id).replace(/'/g, "\\'") + '\')">Uninstall ' + (p.name || p.id) + '</button>';
    nav += '</div>';
    nav += '</div>';
  }
  nav += '</div></div>';
  container.innerHTML = nav;

  // Phase 6b: relocate native settings DOM blocks into their plugin panels.
  // Moves (does not clone) so existing form IDs and saveSettings() keep working.
  document.querySelectorAll('.plugin-native-settings-mount').forEach(function (mount) {
    var targetId = mount.getAttribute('data-target-id');
    if (!targetId) return;
    var node = document.getElementById(targetId);
    if (!node) return;
    // Ensure the claimed node is visible regardless of settings-tab active state.
    node.style.display = '';
    node.classList.remove('settings-tab', 'active');
    mount.appendChild(node);
    var hideSel = mount.getAttribute('data-hide-nav');
    if (hideSel) {
      var navBtn = document.querySelector(hideSel);
      if (navBtn) navBtn.style.display = 'none';
    }
  });

  // Populate any dynamic select fields (e.g. type=select with optionsFrom='aiModels')
  // before loading values, so the saved value lands on a real option.
  plugins.forEach(function (p) {
    (p.settings || []).forEach(function (s) {
      if (!(s.type === 'select' || s.optionsFrom)) return;
      var el = document.getElementById('pluginSetting_' + p.id + '_' + s.key);
      if (!el) return;
      _populatePluginSettingOptions(el, s);
    });
  });

  // Load current values
  plugins.forEach(function (p) {
    if (!p.settings || !p.settings.length) return;
    fetch('/api/plugins/' + p.id + '/config').then(function (r) {
      return r.json();
    }).then(function (cfg) {
      (p.settings || []).forEach(function (s) {
        var el = document.getElementById('pluginSetting_' + p.id + '_' + s.key);
        if (!el) return;
        if (s.type === 'boolean') {
          // Apply current value (fall back to manifest default when undefined)
          var current = cfg[s.key];
          if (current === undefined) current = !!s.default;
          el.checked = !!current;
          _syncPluginToggleVisual(el);
          el.addEventListener('change', function () {
            _syncPluginToggleVisual(el);
          });
          return;
        }
        if (cfg[s.key] !== undefined) {
          el.value = cfg[s.key];
          // Browsers ignore .value if no matching <option> exists yet (dynamic
          // selects). Re-apply once the populate fetch resolves.
          if (el.tagName === 'SELECT' && el.value !== cfg[s.key]) {
            el.dataset.pendingValue = cfg[s.key];
          }
        } else if ((s.secret || s.sensitive) && cfg[s.key + 'Set']) el.placeholder = '(configured)';
      });
    }).catch(function () {});
  });
}
async function refreshSpecialSettingsPanels(plugins) {
  var installed = Array.isArray(plugins) ? plugins : [];
  var videoSection = document.getElementById('settingsSection-videoUse');
  if (!videoSection) return;
  var hasVideoUse = installed.some(function (p) {
    return p && p.id === 'video-use';
  });
  videoSection.style.display = hasVideoUse ? '' : 'none';
  videoSection.querySelectorAll('.plugin-setting-input').forEach(function (el) {
    el.disabled = !hasVideoUse;
  });
  if (!hasVideoUse) return;
  try {
    var res = await fetch('/api/plugins/video-use/config', {
      cache: 'no-store'
    });
    var cfg = res.ok ? await res.json() : {};
    var elevenLabsEl = document.getElementById('pluginSetting_video-use_ElevenLabsApiKey');
    var ffmpegEl = document.getElementById('pluginSetting_video-use_FfmpegPath');
    var ffprobeEl = document.getElementById('pluginSetting_video-use_FfprobePath');
    if (elevenLabsEl) {
      elevenLabsEl.value = cfg.ElevenLabsApiKey || '';
      elevenLabsEl.placeholder = cfg.ElevenLabsApiKeySet ? '(configured)' : 'Optional ElevenLabs key';
    }
    if (ffmpegEl) ffmpegEl.value = cfg.FfmpegPath || 'ffmpeg';
    if (ffprobeEl) ffprobeEl.value = cfg.FfprobePath || 'ffprobe';
  } catch (_) {}
}

// Drives the visual state of the boolean plugin-setting toggle: track color,
// thumb position, and the "On"/"Off" label next to it.
function _syncPluginToggleVisual(input) {
  if (!input) return;
  var label = input.closest('label.plugin-setting-toggle');
  if (!label) return;
  var text = label.querySelector('[data-toggle-label]');
  var on = !!input.checked;
  if (text) {
    text.textContent = on ? 'On' : 'Off';
    text.dataset.toggleLabel = on ? 'on' : 'off';
  }
}

// Resolves dropdown options for plugin settings. Static: setting.options array.
// Dynamic: setting.optionsFrom = 'aiModels' fetches /api/ai/providers and
// shows only providers the user has saved a key for, grouped by provider.
function _populatePluginSettingOptions(el, setting) {
  if (!el || el.tagName !== 'SELECT') return;
  var defaultLabel = setting.placeholder || 'Default (selects automatically)';
  el.innerHTML = '<option value="">' + defaultLabel + '</option>';
  if (Array.isArray(setting.options) && setting.options.length) {
    setting.options.forEach(function (opt) {
      var value = typeof opt === 'string' ? opt : opt.value;
      var label = typeof opt === 'string' ? opt : opt.label || opt.value;
      var o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      el.appendChild(o);
    });
    _applyPendingPluginSelectValue(el);
    return;
  }
  if (setting.optionsFrom === 'aiModels') {
    fetch('/api/ai/providers').then(function (r) {
      return r.json();
    }).then(function (data) {
      var providers = data && data.providers || [];
      var configured = providers.filter(function (p) {
        return p.configured && p.models && p.models.length;
      });
      if (!configured.length) {
        var empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'No AI keys saved -- add one in Settings -> AI Keys';
        empty.disabled = true;
        el.innerHTML = '';
        el.appendChild(empty);
        return;
      }
      configured.forEach(function (p) {
        var group = document.createElement('optgroup');
        group.label = p.label;
        p.models.forEach(function (m) {
          var o = document.createElement('option');
          o.value = m.id;
          o.textContent = m.label;
          group.appendChild(o);
        });
        el.appendChild(group);
      });
      _applyPendingPluginSelectValue(el);
    }).catch(function () {});
  }
}
function _applyPendingPluginSelectValue(el) {
  if (el && el.dataset && el.dataset.pendingValue) {
    var v = el.dataset.pendingValue;
    delete el.dataset.pendingValue;
    el.value = v;
  }
}
function switchPluginSettingsTab(pluginId, btn) {
  document.querySelectorAll('.plugin-settings-nav').forEach(function (b) {
    b.classList.remove('active');
  });
  document.querySelectorAll('.plugin-settings-panel').forEach(function (p) {
    p.style.display = 'none';
  });
  btn.classList.add('active');
  var panel = document.getElementById('ps_' + pluginId);
  if (panel) panel.style.display = '';
}
function toggleSecretField(fieldId, btn) {
  var el = document.getElementById(fieldId);
  if (el.type === 'password') {
    el.type = 'text';
    btn.style.color = 'var(--accent)';
  } else {
    el.type = 'password';
    btn.style.color = 'var(--subtext0)';
  }
}