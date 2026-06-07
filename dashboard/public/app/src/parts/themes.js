// ── Theme System ──────────────────────────────────────────────────────────
const THEME_STORAGE_KEY = 'symphonee-themes';
const ACTIVE_THEME_KEY = 'symphonee-active-theme';
state._themeEditorDirty = false;
state._editorMode = 'dark'; // Built-in theme definitions: simplified to mode + tint + text + accent
const BUILTIN_THEMES = [{
  id: 'industrial-blue',
  name: 'Industrial Blue',
  mode: 'dark',
  tint: '#5577BB',
  text: '#e3e3e8',
  accent: '#078efa'
}, {
  id: 'warm-metallic',
  name: 'Warm Metallic',
  mode: 'dark',
  tint: '#9E8C6C',
  text: '#e8e4dc',
  accent: '#d97757'
}, {
  id: 'futuristic-green',
  name: 'Futuristic Green',
  mode: 'dark',
  tint: '#50A088',
  text: '#ececf1',
  accent: '#10a37f'
}, {
  id: 'arctic-frost',
  name: 'Arctic Frost',
  mode: 'light',
  tint: '#6699CC',
  text: '#1a2332',
  accent: '#2563eb'
}, {
  id: 'warm-sand',
  name: 'Warm Sand',
  mode: 'light',
  tint: '#CC9966',
  text: '#2d2418',
  accent: '#c2703e'
}];

// All CSS var keys for clearing inline overrides
const ALL_CSS_KEYS = ['--crust', '--mantle', '--base', '--surface0', '--surface1', '--surface2', '--overlay0', '--overlay1', '--subtext0', '--subtext1', '--text', '--blue', '--sapphire', '--green', '--yellow', '--peach', '--red', '--mauve', '--teal', '--accent'];

// ── Color conversion helpers ──────────────────────────────────────────────
function _hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255,
    g = parseInt(hex.slice(3, 5), 16) / 255,
    b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0,
    l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;else if (max === g) h = ((b - r) / d + 2) / 6;else h = ((r - g) / d + 4) / 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}
function _hslToHex(h, s, l) {
  h = (h % 360 + 360) % 360;
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(h / 60 % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  return '#' + [r + m, g + m, b + m].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

// ── Theme generation from 4 inputs ───────────────────────────────────────
function generateThemeVars(mode, tint, text, accent) {
  const [h, tintSat, tintLit] = _hexToHsl(tint);
  const [th, ts] = _hexToHsl(text);
  const isDark = mode === 'dark';
  // Derive background saturation from the tint color's own saturation.
  // A grey/black/white tint = 0 saturation backgrounds.
  // A vivid tint = stronger tint in backgrounds (capped for subtlety).
  const litFactor = tintLit > 5 && tintLit < 95 ? 1 : 0;
  const bgSat = Math.round(tintSat / 100 * (isDark ? 12 : 16) * litFactor);
  const bg = l => _hslToHex(h, bgSat, l);
  const txt = l => _hslToHex(th, Math.min(ts, 8), l);
  const darkSemantic = {
    '--blue': '#7cace8',
    '--sapphire': '#6a9ad8',
    '--green': '#7ec699',
    '--yellow': '#e8c47c',
    '--peach': '#d97757',
    '--red': '#f28b82',
    '--mauve': '#c49be8',
    '--teal': '#7ce8d4'
  };
  const lightSemantic = {
    '--blue': '#2563eb',
    '--sapphire': '#1d4ed8',
    '--green': '#16a34a',
    '--yellow': '#ca8a04',
    '--peach': '#ea580c',
    '--red': '#dc2626',
    '--mauve': '#9333ea',
    '--teal': '#0d9488'
  };
  if (isDark) {
    return {
      '--crust': bg(5),
      '--mantle': bg(8),
      '--base': bg(11),
      '--surface0': bg(15),
      '--surface1': bg(18),
      '--surface2': bg(21),
      '--overlay0': bg(27),
      '--overlay1': bg(35),
      '--subtext0': txt(68),
      '--subtext1': txt(78),
      '--text': text,
      '--accent': accent,
      ...(isDark ? darkSemantic : lightSemantic),
      '--term-bg': bg(11),
      '--term-fg': text,
      '--term-cursor': accent,
      '--term-selection': bg(21) + '80'
    };
  } else {
    return {
      '--crust': bg(89),
      '--mantle': bg(93),
      '--base': bg(97),
      '--surface0': bg(93),
      '--surface1': bg(86),
      '--surface2': bg(80),
      '--overlay0': bg(58),
      '--overlay1': bg(46),
      '--subtext0': txt(42),
      '--subtext1': txt(32),
      '--text': text,
      '--accent': accent,
      ...lightSemantic,
      '--term-bg': bg(97),
      '--term-fg': text,
      '--term-cursor': accent,
      '--term-selection': bg(80) + '80'
    };
  }
}

// ── Storage ──────────────────────────────────────────────────────────────
function getSavedThemes() {
  try {
    return JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || '[]');
  } catch (_) {
    return [];
  }
}
function setSavedThemes(themes) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(themes));
  // Also persist to server (config/themes.json) for portability
  const active = localStorage.getItem(ACTIVE_THEME_KEY) || null;
  fetch('/api/themes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      themes,
      active
    })
  }).catch(() => {});
}

// Load themes from server on startup and sync to localStorage
async function _loadThemesFromServer() {
  try {
    const data = await fetch('/api/themes').then(r => r.json());
    if (data.themes && data.themes.length) {
      // Merge: server themes take precedence
      const local = getSavedThemes();
      const merged = [...data.themes];
      // Add any local-only themes not on server
      for (const lt of local) {
        if (!merged.some(t => t.name === lt.name)) merged.push(lt);
      }
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(merged));
      // Restore active theme from server if not set locally
      if (data.active && !localStorage.getItem(ACTIVE_THEME_KEY)) {
        localStorage.setItem(ACTIVE_THEME_KEY, data.active);
      }
    }
  } catch (_) {}
}

// ── Render theme list ────────────────────────────────────────────────────
function renderThemeList() {
  const container = document.getElementById('themeList');
  if (!container) return;
  const themes = getSavedThemes();
  const activeThemeName = localStorage.getItem(ACTIVE_THEME_KEY) || '';
  let html = '';
  for (const b of BUILTIN_THEMES) {
    const isActive = !state._themeEditorDirty && activeThemeName === `__builtin_${b.id}`;
    const modeTag = b.mode === 'light' ? '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:var(--overlay0);color:var(--text);margin-left:4px;">light</span>' : '';
    html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:${isActive ? 'var(--surface1)' : 'var(--surface0)'};border:1px solid ${isActive ? 'var(--accent)' : 'var(--surface1)'};border-radius:var(--radius);cursor:pointer;transition:all 0.12s;" onclick="applyBuiltinTheme('${b.id}')" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='${isActive ? 'var(--accent)' : 'var(--surface1)'}'">` + `<span class="cli-dot" style="background:${b.accent};width:10px;height:10px;"></span>` + `<span style="font-size:12px;color:var(--text);flex:1;">${b.name}${modeTag}</span>` + (isActive ? '<span style="font-size:10px;color:var(--accent);font-weight:600;">Active</span>' : '') + '</div>';
  }
  for (let i = 0; i < themes.length; i++) {
    const t = themes[i];
    const isActive = !state._themeEditorDirty && activeThemeName === t.name;
    const accentColor = t.accent || t.vars && t.vars['--accent'] || 'var(--accent)';
    html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:${isActive ? 'var(--surface1)' : 'var(--surface0)'};border:1px solid ${isActive ? 'var(--accent)' : 'var(--surface1)'};border-radius:var(--radius);cursor:pointer;transition:all 0.12s;" onclick="applyCustomTheme(${i})" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='${isActive ? 'var(--accent)' : 'var(--surface1)'}'">` + `<span class="cli-dot" style="background:${accentColor};width:10px;height:10px;"></span>` + `<span style="font-size:12px;color:var(--text);flex:1;">${esc(t.name)}</span>` + (isActive ? '<span style="font-size:10px;color:var(--accent);font-weight:600;">Active</span>' : '') + `<button onclick="event.stopPropagation();editThemeInEditor(${i})" style="background:none;border:none;color:var(--subtext0);cursor:pointer;padding:2px;display:flex;" title="Edit theme"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>` + `<button onclick="event.stopPropagation();deleteTheme(${i})" style="background:none;border:none;color:var(--subtext0);cursor:pointer;padding:2px;display:flex;" title="Delete theme"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` + '</div>';
  }
  container.innerHTML = html || '<div style="font-size:11px;color:var(--subtext0);">No custom themes saved yet.</div>';
  _initEditorPickers();
}

// ── Simplified editor ────────────────────────────────────────────────────
function _initEditorPickers() {
  const stored = localStorage.getItem(ACTIVE_THEME_KEY) || '';
  let mode = 'dark',
    tint = '#9E8C6C',
    text = '#e8e4dc',
    accent = '#d97757';
  if (stored.startsWith('__builtin_')) {
    const bt = BUILTIN_THEMES.find(b => b.id === stored.replace('__builtin_', ''));
    if (bt) {
      mode = bt.mode;
      tint = bt.tint;
      text = bt.text;
      accent = bt.accent;
    }
  } else if (stored) {
    const t = getSavedThemes().find(t => t.name === stored);
    if (t && t.mode) {
      mode = t.mode;
      tint = t.tint;
      text = t.text;
      accent = t.accent;
    }
  }
  const tintEl = document.getElementById('themeTint');
  const textEl = document.getElementById('themeText');
  const accentEl = document.getElementById('themeAccent');
  if (tintEl) {
    tintEl.value = tint;
    document.getElementById('themeHexTint').textContent = tint;
  }
  if (textEl) {
    textEl.value = text;
    document.getElementById('themeHexText').textContent = text;
  }
  if (accentEl) {
    accentEl.value = accent;
    document.getElementById('themeHexAccent').textContent = accent;
  }
  // Sync advanced pickers
  const vars = generateThemeVars(mode, tint, text, accent);
  _syncAdvancedPickers(vars);
  state._editorMode = mode;
  _updateModeToggle(mode);
}
function _updateModeToggle(mode) {
  const darkBtn = document.getElementById('themeModeDark');
  const lightBtn = document.getElementById('themeModeLight');
  if (!darkBtn || !lightBtn) return;
  if (mode === 'dark') {
    darkBtn.style.background = 'var(--surface1)';
    darkBtn.style.color = 'var(--text)';
    lightBtn.style.background = 'var(--surface0)';
    lightBtn.style.color = 'var(--subtext0)';
  } else {
    lightBtn.style.background = 'var(--surface1)';
    lightBtn.style.color = 'var(--text)';
    darkBtn.style.background = 'var(--surface0)';
    darkBtn.style.color = 'var(--subtext0)';
  }
}
function _setThemeMode(mode) {
  state._editorMode = mode;
  _updateModeToggle(mode);
  _onSimpleThemeChange();
}
function _onSimpleThemeChange(input) {
  // Update hex display if triggered from a picker
  if (input) {
    const hexId = 'themeHex' + input.id.replace('theme', '');
    const hexEl = document.getElementById(hexId);
    if (hexEl) hexEl.textContent = input.value;
  }
  // Mark dirty
  if (!state._themeEditorDirty) {
    state._themeEditorDirty = true;
    const status = document.getElementById('themeEditorStatus');
    if (status) status.style.display = '';
    renderThemeList();
  }
  // Generate and live preview
  const tint = document.getElementById('themeTint')?.value || '#9E8C6C';
  const text = document.getElementById('themeText')?.value || '#e8e4dc';
  const accent = document.getElementById('themeAccent')?.value || '#d97757';
  const vars = generateThemeVars(state._editorMode, tint, text, accent);
  _applyVarsAsCustom(vars);
  // Sync advanced pickers with generated values
  _syncAdvancedPickers(vars);
}
function _syncAdvancedPickers(vars) {
  const map = {
    themeAdvSidebar: vars['--mantle'],
    themeAdvHeader: vars['--mantle'],
    themeAdvBase: vars['--base'],
    themeAdvTermBg: vars['--term-bg'] || vars['--base'],
    themeAdvTermFg: vars['--term-fg'] || vars['--text'],
    themeAdvTermCursor: vars['--term-cursor'] || vars['--accent']
  };
  for (const [id, val] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  }
  // Reset area overrides when basic controls change (they regenerate everything)
  const root = document.documentElement;
  root.style.removeProperty('--sidebar-bg');
  root.style.removeProperty('--header-bg');
  root.style.removeProperty('--tab-bar-bg');
  root.style.removeProperty('--content-bg');
}
function _onAdvancedThemeChange(cssVar, value) {
  document.documentElement.style.setProperty(cssVar, value);
  _markThemeDirty();
}
function _onAdvancedHeaderChange(value) {
  document.documentElement.style.setProperty('--header-bg', value);
  document.documentElement.style.setProperty('--tab-bar-bg', value);
  _markThemeDirty();
}
function _onAdvancedTermChange(prop, value) {
  if (!TERM_THEMES['_active']) {
    TERM_THEMES['_active'] = {
      ...getActiveTermTheme()
    };
  }
  TERM_THEMES['_active'][prop] = value;
  applyShellTheme();
  _markThemeDirty();
}
function toggleThemeEditor() {
  const panel = document.getElementById('themeEditorPanel');
  const btn = document.getElementById('themeNewBtn');
  if (!panel) return;
  const showing = panel.style.display !== 'none';
  panel.style.display = showing ? 'none' : '';
  if (btn) btn.textContent = showing ? 'New Theme' : 'Close Editor';
  if (!showing) _initEditorPickers();
}
function _markThemeDirty() {
  if (!state._themeEditorDirty) {
    state._themeEditorDirty = true;
    const status = document.getElementById('themeEditorStatus');
    if (status) status.style.display = '';
    renderThemeList();
  }
}
function _applyVarsAsCustom(vars) {
  const root = document.documentElement;
  root.setAttribute('data-theme', 'custom');
  for (const [k, v] of Object.entries(vars)) {
    if (!k.startsWith('--term-')) root.style.setProperty(k, v);
  }
  const customTermTheme = {
    background: vars['--term-bg'] || vars['--base'] || '#1e1e1c',
    foreground: vars['--term-fg'] || vars['--text'] || '#e8e4dc',
    cursor: vars['--term-cursor'] || vars['--accent'] || '#d97757',
    selectionBackground: vars['--term-selection'] || (vars['--surface2'] || '#363632') + '80'
  };
  TERM_THEMES['_active'] = customTermTheme;
  state.activeThemeId = '_active';
  applyShellTheme();
}

// ── Save / apply / delete ────────────────────────────────────────────────
function saveCustomThemeFromEditor() {
  const name = document.getElementById('themeNameInput')?.value.trim();
  if (!name) {
    toast('Enter a theme name', 'info');
    return;
  }
  const tint = document.getElementById('themeTint')?.value || '#9E8C6C';
  const text = document.getElementById('themeText')?.value || '#e8e4dc';
  const accent = document.getElementById('themeAccent')?.value || '#d97757';
  const vars = generateThemeVars(state._editorMode, tint, text, accent);
  const themes = getSavedThemes();
  const themeObj = {
    name,
    mode: state._editorMode,
    tint,
    text,
    accent,
    vars
  };
  const existing = themes.findIndex(t => t.name === name);
  if (existing >= 0) themes[existing] = themeObj;else themes.push(themeObj);
  localStorage.setItem(ACTIVE_THEME_KEY, name);
  setSavedThemes(themes);
  _applyVarsAsCustom(vars);
  state._themeEditorDirty = false;
  const status = document.getElementById('themeEditorStatus');
  if (status) status.style.display = 'none';
  document.getElementById('themeNameInput').value = '';
  renderThemeList();
  restartAllTerminalsForTheme();
  toast('Theme "' + name + '" saved', 'success');
}
function editThemeInEditor(idx) {
  const themes = getSavedThemes();
  const t = themes[idx];
  if (!t) return;
  applyCustomTheme(idx);
  const nameInput = document.getElementById('themeNameInput');
  if (nameInput) nameInput.value = t.name;
  // Populate editor pickers
  if (t.mode && t.tint) {
    state._editorMode = t.mode;
    _updateModeToggle(t.mode);
    const tintEl = document.getElementById('themeTint');
    const textEl = document.getElementById('themeText');
    const accentEl = document.getElementById('themeAccent');
    if (tintEl) {
      tintEl.value = t.tint;
      document.getElementById('themeHexTint').textContent = t.tint;
    }
    if (textEl) {
      textEl.value = t.text;
      document.getElementById('themeHexText').textContent = t.text;
    }
    if (accentEl) {
      accentEl.value = t.accent;
      document.getElementById('themeHexAccent').textContent = t.accent;
    }
  }
}
function applyBuiltinTheme(themeId, opts) {
  state._themeEditorDirty = false;
  const status = document.getElementById('themeEditorStatus');
  if (status) status.style.display = 'none';
  const root = document.documentElement;
  ALL_CSS_KEYS.forEach(k => root.style.removeProperty(k));
  // Clear area-specific overrides
  ['--sidebar-bg', '--header-bg', '--tab-bar-bg', '--content-bg'].forEach(k => root.style.removeProperty(k));
  localStorage.setItem(ACTIVE_THEME_KEY, `__builtin_${themeId}`);
  // Persist active selection to server
  fetch('/api/themes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      themes: getSavedThemes(),
      active: `__builtin_${themeId}`
    })
  }).catch(() => {});
  state.activeThemeId = themeId;
  delete TERM_THEMES['_active'];
  root.setAttribute('data-theme', themeId);
  applyShellTheme();
  if (!(opts && opts.skipRestart)) restartAllTerminalsForTheme();
  renderThemeList();
}
function applyCustomTheme(idx, opts) {
  state._themeEditorDirty = false;
  const statusEl = document.getElementById('themeEditorStatus');
  if (statusEl) statusEl.style.display = 'none';
  const themes = getSavedThemes();
  const t = themes[idx];
  if (!t) return;
  localStorage.setItem(ACTIVE_THEME_KEY, t.name);
  const root = document.documentElement;
  ALL_CSS_KEYS.forEach(k => root.style.removeProperty(k));
  // If theme has simplified params, regenerate vars for freshness
  if (t.mode && t.tint) {
    const vars = generateThemeVars(t.mode, t.tint, t.text, t.accent);
    _applyVarsAsCustom(vars);
  } else {
    _applyVarsAsCustom(t.vars);
  }
  if (!(opts && opts.skipRestart)) restartAllTerminalsForTheme();
  renderThemeList();
}
function deleteTheme(idx) {
  const themes = getSavedThemes();
  const deleted = themes.splice(idx, 1)[0];
  setSavedThemes(themes);
  if (deleted && localStorage.getItem(ACTIVE_THEME_KEY) === deleted.name) {
    localStorage.removeItem(ACTIVE_THEME_KEY);
    applyBuiltinTheme('industrial-blue');
  }
  renderThemeList();
  toast('Theme deleted', 'success');
}
function exportThemes() {
  const themes = getSavedThemes();
  if (!themes.length) {
    toast('No custom themes to export', 'info');
    return;
  }
  const blob = new Blob([JSON.stringify(themes, null, 2)], {
    type: 'application/json'
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'symphonee-themes.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Themes exported', 'success');
}
function importThemes() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported) || !imported.every(t => t.name && (t.vars || t.tint))) {
        toast('Invalid theme file format', 'error');
        return;
      }
      const existing = getSavedThemes();
      let added = 0;
      for (const t of imported) {
        if (!existing.some(e => e.name === t.name)) {
          existing.push(t);
          added++;
        }
      }
      setSavedThemes(existing);
      renderThemeList();
      toast(`Imported ${added} theme${added !== 1 ? 's' : ''}`, 'success');
    } catch (_) {
      toast('Failed to parse theme file', 'error');
    }
  };
  input.click();
}

// Restore theme on load (with migration from old CLI-based names)
function restoreCustomTheme() {
  const stored = localStorage.getItem(ACTIVE_THEME_KEY);
  // The startup path must NOT restart terminals - the main shell has
  // already spawned (or is about to); a restart here would leave the main
  // shell blank until the user switches tabs.
  const startupOpts = {
    skipRestart: true
  };
  if (!stored) {
    applyBuiltinTheme('industrial-blue', startupOpts);
    return;
  }
  if (stored.startsWith('__builtin_')) {
    let id = stored.replace('__builtin_', '');
    // Migrate old CLI-based theme IDs
    const migrate = {
      claude: 'warm-metallic',
      gemini: 'industrial-blue',
      codex: 'futuristic-green',
      copilot: 'warm-metallic',
      grok: 'warm-metallic'
    };
    if (migrate[id]) {
      id = migrate[id];
      localStorage.setItem(ACTIVE_THEME_KEY, `__builtin_${id}`);
    }
    if (BUILTIN_THEMES.some(b => b.id === id)) applyBuiltinTheme(id, startupOpts);
    return;
  }
  const themes = getSavedThemes();
  const idx = themes.findIndex(t => t.name === stored);
  if (idx >= 0) applyCustomTheme(idx, startupOpts);
}
// Load themes from server, then restore the active theme
_loadThemesFromServer().then(() => restoreCustomTheme()).catch(() => restoreCustomTheme());