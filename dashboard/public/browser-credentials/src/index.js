// browser-credentials -- the Browser settings tab: saved browser-login
// credentials + the router/Stagehand/in-app-agent settings loader/saver. Split
// out of the old parts/browser-credentials.js (which also held the plugin
// registry; that is now its own plugin-registry module). esbuild IIFE;
// _renderBrowserCredsInto stays private. No top-level execution; loads after
// app.js with the rest. Runtime deps resolve via window: state, esc (onboarding),
// toast, and _syncPluginToggleVisual / _populatePluginSettingOptions (plugins
// part). See ARCHITECTURE.md.
//
// ── Browser Credential Management ───────────────────────────────────────
function _renderBrowserCredsInto(listEl) {
  if (!listEl) return;
  const creds = state.configData.BrowserCredentials || {};
  const entries = Object.entries(creds);
  if (!entries.length) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--subtext1);padding:4px 0;">No credentials saved.</div>';
    return;
  }
  listEl.innerHTML = entries.map(([name, data]) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--surface0);">
      <span style="font-size:12px;color:var(--text);flex:1;">${esc(name)}</span>
      <span style="font-size:11px;color:var(--subtext0);flex:1;">${esc(data.email || '')}</span>
      <button class="modal-btn" onclick="removeBrowserCredential('${esc(name)}')" style="padding:2px 8px;font-size:10px;color:var(--red);">Remove</button>
    </div>`).join('');
}
function renderBrowserCreds() {
  // Render into both surfaces (legacy AI Tools section, and the dedicated
  // Browser settings tab) so credentials stay in sync wherever the user looks.
  _renderBrowserCredsInto(document.getElementById('browserCredList'));
  _renderBrowserCredsInto(document.getElementById('browserCredListBrowser'));
}
function addBrowserCredential() {
  const name = document.getElementById('browserCredName').value.trim();
  const email = document.getElementById('browserCredEmail').value.trim();
  const pass = document.getElementById('browserCredPass').value;
  if (!name || !email || !pass) {
    toast('All fields required', 'error');
    return;
  }
  if (!state.configData.BrowserCredentials) state.configData.BrowserCredentials = {};
  state.configData.BrowserCredentials[name] = {
    email,
    password: pass
  };
  document.getElementById('browserCredName').value = '';
  document.getElementById('browserCredEmail').value = '';
  document.getElementById('browserCredPass').value = '';
  renderBrowserCreds();
}
function addBrowserCredentialBrowserTab() {
  const name = document.getElementById('browserCredNameBrowser').value.trim();
  const email = document.getElementById('browserCredEmailBrowser').value.trim();
  const pass = document.getElementById('browserCredPassBrowser').value;
  if (!name || !email || !pass) {
    toast('All fields required', 'error');
    return;
  }
  if (!state.configData.BrowserCredentials) state.configData.BrowserCredentials = {};
  state.configData.BrowserCredentials[name] = {
    email,
    password: pass
  };
  document.getElementById('browserCredNameBrowser').value = '';
  document.getElementById('browserCredEmailBrowser').value = '';
  document.getElementById('browserCredPassBrowser').value = '';
  renderBrowserCreds();
}
function removeBrowserCredential(name) {
  if (state.configData.BrowserCredentials) delete state.configData.BrowserCredentials[name];
  renderBrowserCreds();
}

// ── Browser settings tab loader / saver ────────────────────────────────────
async function refreshBrowserSettings() {
  // Router defaults (live in main config under BrowserRouter).
  const r = state.configData.BrowserRouter || {};
  const defEl = document.getElementById('settingsBrowserRouterDefault');
  if (defEl) defEl.value = r.default || 'auto';
  const preferEl = document.getElementById('settingsBrowserRouterPreferStagehand');
  if (preferEl) {
    preferEl.checked = r.preferStagehand !== false;
    _syncPluginToggleVisual(preferEl);
    if (!preferEl._wired) {
      preferEl.addEventListener('change', () => _syncPluginToggleVisual(preferEl));
      preferEl._wired = true;
    }
  }

  // Populate dynamic model dropdowns.
  const inAppModelEl = document.getElementById('settingsInAppAgentModel');
  if (inAppModelEl) _populatePluginSettingOptions(inAppModelEl, {
    optionsFrom: 'aiModels',
    placeholder: 'Default (auto-pick from saved keys)'
  });
  const stagehandModelEl = document.getElementById('settingsStagehandModel');
  if (stagehandModelEl) _populatePluginSettingOptions(stagehandModelEl, {
    optionsFrom: 'aiModels',
    placeholder: 'Default (Claude Sonnet 4.6)'
  });

  // Stagehand plugin settings live on the plugin's own config endpoint.
  try {
    const res = await fetch('/api/plugins/stagehand/config', {
      cache: 'no-store'
    });
    const cfg = res.ok ? await res.json() : {};
    if (stagehandModelEl) {
      if (cfg.model !== undefined) {
        stagehandModelEl.value = cfg.model;
        if (stagehandModelEl.value !== cfg.model) stagehandModelEl.dataset.pendingValue = cfg.model;
      }
    }
    const headlessEl = document.getElementById('settingsStagehandHeadless');
    if (headlessEl) {
      // Manifest default is on; treat undefined as on.
      headlessEl.checked = cfg.headless !== false;
      _syncPluginToggleVisual(headlessEl);
      if (!headlessEl._wired) {
        headlessEl.addEventListener('change', () => _syncPluginToggleVisual(headlessEl));
        headlessEl._wired = true;
      }
    }
  } catch (_) {}

  // In-app agent model (lives under InAppAgent in main config).
  const inApp = state.configData.InAppAgent || {};
  if (inAppModelEl && inApp.model) {
    inAppModelEl.value = inApp.model;
    if (inAppModelEl.value !== inApp.model) inAppModelEl.dataset.pendingValue = inApp.model;
  }

  // Refresh the credentials list.
  renderBrowserCreds();
}
async function saveBrowserSettings() {
  // Router and in-app agent prefs go into the main config payload via
  // saveSettings(); this helper just persists the plugin-scoped Stagehand
  // settings out-of-band so a single Save click writes everything.
  try {
    const stagehandModel = (document.getElementById('settingsStagehandModel') || {}).value || '';
    const stagehandHeadless = !!(document.getElementById('settingsStagehandHeadless') || {}).checked;
    const body = {
      headless: stagehandHeadless
    };
    if (stagehandModel) body.model = stagehandModel;
    await fetch('/api/plugins/stagehand/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (_) {}
}

// ── Public surface ──────────────────────────────────────────────────────────
// All reached from onclick (the AI-Tools + Browser settings panels) or
// settings.js (renderBrowserCreds / saveBrowserSettings). _renderBrowserCredsInto
// is private.
window.renderBrowserCreds = renderBrowserCreds;
window.addBrowserCredential = addBrowserCredential;
window.addBrowserCredentialBrowserTab = addBrowserCredentialBrowserTab;
window.removeBrowserCredential = removeBrowserCredential;
window.refreshBrowserSettings = refreshBrowserSettings;
window.saveBrowserSettings = saveBrowserSettings;
