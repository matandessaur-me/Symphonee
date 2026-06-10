// ── Re-focus terminal when window regains focus ─────────────────────────
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
// ── A11y: keyboard operability for non-native controls + the tab list ────────
// Several header controls are <div role="button">; native buttons activate on
// Enter/Space but divs don't. And the main tab bar is an ARIA tablist, which is
// expected to support Arrow/Home/End navigation. Both are wired here, defensively
// (scoped to the relevant targets) so they never interfere with the terminal,
// inputs, or the existing shortcut system.
(function a11yKeyboard() {
  function isFormish(el) {
    const t = (el && el.tagName) || '';
    return /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t) || (el && el.isContentEditable);
  }

  // Enter / Space activate a focused role="button" that isn't a native control.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const el = document.activeElement;
    if (!el || el.getAttribute('role') !== 'button' || isFormish(el)) return;
    e.preventDefault();           // Space would otherwise scroll the page
    el.click();
  });

  // Arrow-key navigation across the main tab list (visible tabs only).
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const el = document.activeElement;
    if (!el || el.getAttribute('role') !== 'tab' || !el.classList.contains('tab-btn')) return;
    const tabs = Array.from(document.querySelectorAll('.tab-btn[role="tab"]'))
      .filter(t => t.offsetParent !== null);   // skip display:none tabs
    if (!tabs.length) return;
    const i = tabs.indexOf(el);
    let next = i;
    if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    const target = tabs[next];
    if (target && target !== el) {
      e.preventDefault();
      target.focus();
      target.click();             // automatic activation (APG tabs pattern)
    }
  });
})();
