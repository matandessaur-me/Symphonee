// ── Utilities ───────────────────────────────────────────────────────────
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
}