// ── Apps tab (desktop control) ────────────────────────────────────────────
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
function _appsOnProviderChange() {
  const sel = document.getElementById('appsProviderSelect');
  if (!sel) return;
  _appsState.providerKey = sel.value || null;
  _appsSaveProvider(_appsState.providerKey);
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
}