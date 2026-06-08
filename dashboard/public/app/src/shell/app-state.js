// ── Focus / context-awareness state push ────────────────────────────────
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
});