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
    // MUST stay false for a ConPTY-backed terminal: ConPTY already emits proper
    // \r\n, and TUIs use bare \n as pure cursor-down PRESERVING the column.
    // convertEol:true forced those to column 0, displacing the leading
    // characters of lines (the "ghost first letters" corruption). VS Code also
    // leaves this off for its PTY terminal.
    convertEol: false,
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
  // WebGL renderer. The terminal-corruption saga (ghost first-letters on
  // scroll, misplaced TUI content) turned out to be convertEol -- see
  // createTermOpts -- NOT the renderer; the auto-repair machinery that lived
  // here (scroll-settle geometry repair, DPR watcher, post-load resync) was
  // removed once the root cause was confirmed fixed. If corruption ever
  // reappears, the command palette's "Repair Terminal" resyncs by hand.
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

  // Inject clipboard text into the PTY, de-duplicated. Two paste paths can fire
  // for a SINGLE user action on some setups -- e.g. a right-click that triggers
  // both the contextmenu handler below AND a native 'paste' event, or a mouse
  // utility that maps right-click to a paste keystroke -- which pasted twice.
  // Drop an identical payload that arrives within a short window so one action
  // injects exactly once. Shared by Ctrl/Cmd+V, the right-click menu, and the
  // paste event (Win+V, dictation tools like Wispr Flow).
  let _lastPaste = { text: '', at: 0 };
  function sendPaste(text) {
    if (!text || !(state.ws && state.ws.readyState === 1)) return;
    const now = Date.now();
    if (text === _lastPaste.text && (now - _lastPaste.at) < 120) return;
    _lastPaste = { text, at: now };
    state.ws.send(JSON.stringify({ type: 'input', termId, data: text }));
  }

  // Send clipboard text to the PTY. Shared by Ctrl/Cmd+V and the right-click menu.
  async function pasteIntoTerm() {
    try {
      sendPaste(await navigator.clipboard.readText());
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
    sendPaste(text);
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
// Full terminal resync -- the one-keystroke equivalent of the user's manual
// "collapse/expand the side panel" fix. A client-side repaint alone is not
// enough when the corruption involves the PTY layer: bounce the PTY one row
// and back so ConPTY re-lays out its buffer and the running TUI receives a
// real resize (SIGWINCH-equivalent) and fully redraws, then refit + repaint.
// Exposed on window for the command palette ("Repair Terminal").
window.repairActiveTerminal = function () {
  const inst = termInstances.get(state.activeTermId);
  if (!inst) return;
  try { inst.fitAddon.fit(); } catch (_) {}
  const cols = inst.term.cols, rows = inst.term.rows;
  const send = (c, r) => {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({
      type: 'resize', termId: state.activeTermId, cols: c, rows: r
    }));
  };
  try { inst.term.resize(cols, rows - 1); } catch (_) {}
  send(cols, rows - 1);
  setTimeout(() => {
    try { inst.term.resize(cols, rows); } catch (_) {}
    send(cols, rows);
    state.lastCols = cols;
    state.lastRows = rows;
    try { inst.term.refresh(0, inst.term.rows - 1); } catch (_) {}
    if (typeof toast === 'function') toast('Terminal repaired (renderer + PTY resynced)', 'success', { duration: 2000 });
  }, 60);
};

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
}