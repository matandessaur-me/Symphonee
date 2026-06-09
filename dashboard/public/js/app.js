/* The served dashboard/public/js/app.js is GENERATED -- the byte-exact concatenation
   of dashboard/public/app/src/shell/*.js (per shell/manifest.json). Edit the shell
   sources here, then run `node scripts/build-renderer.js`. Do NOT edit js/app.js. */
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
          // Mirror into the browser DevTools drawer's Server panel.
          if (window.browserDevtoolsOnTerminalOutput) window.browserDevtoolsOnTerminalOutput(tid, msg.data);
          break;
        }
      case 'browser-devtools':
        if (window.browserDevtoolsOnEvent) window.browserDevtoolsOnEvent(msg);
        break;
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
          if (window.browserDevtoolsOnTermCwd) window.browserDevtoolsOnTermCwd(tid, msg.cwd, msg.repo);
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
});// ── Bottom Hints Visibility ─────────────────────────────────────────────
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

// Keyboard control (typeform feel): Enter advances; Left/Right arrows step
// between cards. Arrows only navigate when focus is NOT in a field, so they
// still move the caret while the user is typing. Textareas keep their newline
// on Enter; modifier combos are ignored.
document.addEventListener('keydown', e => {
  const ob = document.getElementById('onboarding');
  if (!ob || !ob.classList.contains('visible')) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const tag = e.target && e.target.tagName;
  if (e.key === 'Enter') {
    if (tag === 'TEXTAREA') return;
    e.preventDefault();
    obNav(1);
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // let arrows move the caret in fields
    e.preventDefault();
    obNav(e.key === 'ArrowRight' ? 1 : -1);
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