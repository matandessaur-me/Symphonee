// apps -- the desktop-app automation subsystem: the launcher, the automations
// list + step-builder (drag/drop rows, UIA tree, recording, COM mode), the agent
// chat, instructions, and run controls. Bundled from the former parts/apps.js +
// apps-step-builder.js -- one tightly-coupled unit (~26 cross-calls + shared
// _appsAutomations/_APPS_PALETTE), now a single esbuild IIFE so those resolve
// internally; only the ~63 externally-reached functions are on window. Reads
// `state` + listeners at load -> after app.js. esc/toast/... resolve via window.
// See ARCHITECTURE.md.

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
})();
// ── Public surface (reached from index.html / other parts / generated handlers) ──
window._appsBuilderClearUia = _appsBuilderClearUia;
window._appsBuilderDragEnd = _appsBuilderDragEnd;
window._appsBuilderDragLeave = _appsBuilderDragLeave;
window._appsBuilderDragOver = _appsBuilderDragOver;
window._appsBuilderDragStart = _appsBuilderDragStart;
window._appsBuilderDrop = _appsBuilderDrop;
window._appsBuilderRemove = _appsBuilderRemove;
window._appsBuilderUpdate = _appsBuilderUpdate;
window._appsComSetMode = _appsComSetMode;
window._appsComSubmit = _appsComSubmit;
window._appsHeroOpenComModal = _appsHeroOpenComModal;
window._appsOnProviderChange = _appsOnProviderChange;
window._appsPaletteAppend = _appsPaletteAppend;
window._appsPaletteAreaDrop = _appsPaletteAreaDrop;
window._appsPaletteDragStart = _appsPaletteDragStart;
window._appsToggleStepThrough = _appsToggleStepThrough;
window._appsUiaInsertRow = _appsUiaInsertRow;
window._appsUiaToggleRow = _appsUiaToggleRow;
window._appsVerbPickToggle = _appsVerbPickToggle;
window.appsAutomationsAddRow = appsAutomationsAddRow;
window.appsAutomationsDelete = appsAutomationsDelete;
window.appsAutomationsExportAll = appsAutomationsExportAll;
window.appsAutomationsGenerate = appsAutomationsGenerate;
window.appsAutomationsImportFile = appsAutomationsImportFile;
window.appsAutomationsNew = appsAutomationsNew;
window.appsAutomationsPickElement = appsAutomationsPickElement;
window.appsAutomationsRefreshTree = appsAutomationsRefreshTree;
window.appsAutomationsRepickStep = appsAutomationsRepickStep;
window.appsAutomationsRunNow = appsAutomationsRunNow;
window.appsAutomationsRunSelected = appsAutomationsRunSelected;
window.appsAutomationsSave = appsAutomationsSave;
window.appsAutomationsSelect = appsAutomationsSelect;
window.appsAutomationsSetView = appsAutomationsSetView;
window.appsAutomationsStopRecording = appsAutomationsStopRecording;
window.appsAutomationsTestStep = appsAutomationsTestStep;
window.appsAutomationsToggleHistory = appsAutomationsToggleHistory;
window.appsAutomationsToggleRecord = appsAutomationsToggleRecord;
window.appsAutomationsTriggerImport = appsAutomationsTriggerImport;
window.appsChatKeydown = appsChatKeydown;
window.appsChatSend = appsChatSend;
window.appsClearInstructions = appsClearInstructions;
window.appsClearSelectedRecipe = appsClearSelectedRecipe;
window.appsCloseAutomations = appsCloseAutomations;
window.appsCloseInstructions = appsCloseInstructions;
window.appsCloseLauncher = appsCloseLauncher;
window.appsExportInstructions = appsExportInstructions;
window.appsImportInstructionsFile = appsImportInstructionsFile;
window.appsImportInstructionsTrigger = appsImportInstructionsTrigger;
window.appsInterrupt = appsInterrupt;
window.appsOpenAutomations = appsOpenAutomations;
window.appsOpenInstructions = appsOpenInstructions;
window.appsOpenLauncher = appsOpenLauncher;
window.appsPanic = appsPanic;
window.appsRefreshAll = appsRefreshAll;
window.appsRefreshWindows = appsRefreshWindows;
window.appsRenderLauncher = appsRenderLauncher;
window.appsReset = appsReset;
window.appsSaveCurrentAsAutomation = appsSaveCurrentAsAutomation;
window.appsSaveInstructions = appsSaveInstructions;
window.appsSetLauncherSection = appsSetLauncherSection;
window.appsSubmitAdd = appsSubmitAdd;
window.appsToggleAddForm = appsToggleAddForm;
window.handleAppsAgentStep = handleAppsAgentStep;
