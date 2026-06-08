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
});// ── Orchestrator ────────────────────────────────────────────────────────
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
// loadConfig + plugin reconcile (refreshPluginActivation/reconcilePluginShell-
// Surfaces) now live in post-app.js ES modules (work-items, plugins), so this
// boot sequence must run AFTER those <script>s execute. They all load before
// DOMContentLoaded fires, so defer the boot to it. (Running it inline during
// app.js -- as before extraction -- now throws "loadConfig is not defined",
// leaving state.configData empty: no repos in the PR tab, empty backlog/areas.)
document.addEventListener('DOMContentLoaded', async () => {
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
});

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
})();// ── Utilities ───────────────────────────────────────────────────────────
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
// Exposed on window so the extracted command-palette module (loaded after app.js)
// can read the hotkey action list for its shortcut-help view. keyboard.js owns it.
window.HOTKEY_ACTIONS = HOTKEY_ACTIONS;
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
}