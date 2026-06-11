// spaces-repos -- spaces (non-git workspaces) + repo management: the space
// switcher/dialogs, the repo sidebar list, selectRepo (core: many parts/modules
// call it), per-repo git-status polling, and the manage-space dialog. esbuild
// IIFE; the switcher/popover/polling helpers and openAddSpaceDialog's local
// wizard handlers stay private. Registers global click/DOMContentLoaded
// listeners + starts git-status polling at load + reads `state`, so it loads
// AFTER app.js. OWNS CORE_SPACE_PLUGIN_IDS (used by plugins.js) -> re-exposed on
// window. esc/toast/switchTab/loadFileTree/... resolve via window. See ARCHITECTURE.md.
const CORE_SPACE_PLUGIN_IDS = new Set(['browser-use', 'video-use', 'stagehand']);
function isCoreSpacePluginId(id) {
  return CORE_SPACE_PLUGIN_IDS.has(id);
}
// Single wizard handles both create and edit. In edit mode it pre-populates
// identity, repos, and plugins from the existing space so the user can adjust
// any of them in one place (matches the create flow 1:1).
async function openAddSpaceDialog(opts = {}) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isEdit = !!opts.edit;
  const originalName = isEdit ? opts.name || '' : null;
  let step = 1;
  const state = {
    name: opts.name || '',
    description: opts.description || '',
    icon: opts.icon || 'layers',
    repos: Array.isArray(opts.repos) ? opts.repos.slice() : [],
    plugins: Array.isArray(opts.plugins) ? opts.plugins.slice() : []
  };
  const [allRepos, allSpaces, allPlugins] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({})), fetch('/api/plugins').then(r => r.json()).catch(() => [])]);
  // In edit mode, repos already in THIS space should still be selectable
  // (they're "taken" by this space, but the user is editing this space).
  const takenRepos = new Set(Object.entries(allSpaces).filter(([n]) => !isEdit || n !== originalName).flatMap(([, s]) => s.repos || []));
  const freeRepos = Object.keys(allRepos).filter(r => !takenRepos.has(r));
  const pluginList = (Array.isArray(allPlugins) ? allPlugins : []).filter(p => p && !isCoreSpacePluginId(p.id));
  const originalRepos = isEdit ? Array.isArray(opts.repos) ? opts.repos.slice() : [] : [];
  let overlay = document.getElementById('_asoOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = '_asoOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:4000;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  document.body.appendChild(overlay);
  const ASO_ICONS = [{
    n: 'layers',
    l: 'General'
  }, {
    n: 'briefcase',
    l: 'Work'
  }, {
    n: 'folder',
    l: 'Folder'
  }, {
    n: 'user',
    l: 'Personal'
  }, {
    n: 'users',
    l: 'Team'
  }, {
    n: 'code-2',
    l: 'Code'
  }, {
    n: 'terminal',
    l: 'Terminal'
  }, {
    n: 'globe',
    l: 'Web'
  }, {
    n: 'smartphone',
    l: 'Mobile'
  }, {
    n: 'database',
    l: 'Data'
  }, {
    n: 'server',
    l: 'Infra'
  }, {
    n: 'cloud',
    l: 'Cloud'
  }, {
    n: 'shield',
    l: 'Security'
  }, {
    n: 'rocket',
    l: 'Startup'
  }, {
    n: 'star',
    l: 'Favorites'
  }, {
    n: 'building-2',
    l: 'Company'
  }, {
    n: 'palette',
    l: 'Design'
  }, {
    n: 'book-open',
    l: 'Docs'
  }, {
    n: 'cpu',
    l: 'AI / ML'
  }, {
    n: 'zap',
    l: 'Fast'
  }, {
    n: 'package',
    l: 'Packages'
  }, {
    n: 'git-branch',
    l: 'Git'
  }, {
    n: 'layout-dashboard',
    l: 'Dashboard'
  }, {
    n: 'music',
    l: 'Creative'
  }, {
    n: 'flask-conical',
    l: 'Experiment'
  }];
  function renderStep() {
    const STEP_LABELS = ['Identity', 'Repos', 'Plugins'];
    const stepDotsHtml = STEP_LABELS.map((lbl, i) => {
      const n = i + 1,
        active = n === step,
        done = n < step;
      const bg = done || active ? 'var(--accent)' : 'var(--surface2)';
      const fg = done || active ? 'var(--crust)' : 'var(--subtext0)';
      const inner = done ? '<i data-lucide="check" style="width:10px;height:10px;"></i>' : n;
      const line = n < 3 ? `<div style="width:20px;height:1px;background:${n < step ? 'var(--accent)' : 'var(--surface2)'};margin:0 6px;"></div>` : '';
      return `<div style="display:flex;align-items:center;">
        <div style="display:flex;align-items:center;gap:5px;">
          <div style="width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;background:${bg};color:${fg};">${inner}</div>
          <span style="font-size:11px;font-weight:${active ? '700' : '500'};color:${active ? 'var(--text)' : 'var(--subtext0)'};">${lbl}</span>
        </div>${line}
      </div>`;
    }).join('');
    let bodyHtml = '';
    if (step === 1) {
      const iconGridHtml = ASO_ICONS.map(ico => {
        const sel = ico.n === state.icon;
        return `<button type="button" data-pick-icon="${esc(ico.n)}" title="${esc(ico.l)}" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
          width:52px;height:52px;border-radius:8px;border:1px solid ${sel ? 'var(--accent)' : 'var(--surface2)'};
          background:${sel ? 'color-mix(in srgb,var(--accent) 15%,var(--surface1))' : 'var(--surface1)'};
          cursor:pointer;padding:0;transition:border-color 0.12s,background 0.12s;">
          <i data-lucide="${esc(ico.n)}" style="width:15px;height:15px;color:${sel ? 'var(--accent)' : 'var(--subtext1)'};"></i>
          <span style="font-size:9px;color:${sel ? 'var(--accent)' : 'var(--subtext0)'};font-family:var(--font-ui);line-height:1.1;text-align:center;padding:0 2px;">${esc(ico.l)}</span>
        </button>`;
      }).join('');
      bodyHtml = `
        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--subtext1);margin-bottom:5px;">Name <span style="color:var(--red);">*</span></label>
          <input id="_asoName" type="text" value="${esc(state.name)}" placeholder="e.g. Personal, Work, Client Studio"
            style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface1);border:1px solid var(--surface2);border-radius:var(--radius);color:var(--text);font:13px var(--font-ui);outline:none;transition:border-color 0.12s;"
            onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--surface2)'"
            oninput="document.getElementById('_asoNameErr').style.display='none'">
          <div id="_asoNameErr" style="display:none;color:var(--red);font-size:10px;margin-top:3px;">Name is required.</div>
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:11px;font-weight:600;color:var(--subtext1);margin-bottom:5px;">Description <span style="color:var(--subtext0);font-weight:400;">(optional)</span></label>
          <input id="_asoDesc" type="text" value="${esc(state.description)}" placeholder="Short description"
            style="width:100%;box-sizing:border-box;padding:8px 10px;background:var(--surface1);border:1px solid var(--surface2);border-radius:var(--radius);color:var(--text);font:13px var(--font-ui);outline:none;transition:border-color 0.12s;"
            onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--surface2)'">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:600;color:var(--subtext1);margin-bottom:8px;">Icon</label>
          <div style="display:grid;grid-template-columns:repeat(5,52px);gap:6px;">${iconGridHtml}</div>
        </div>`;
    } else if (step === 2) {
      const items = freeRepos.length ? freeRepos.map(r => {
        const chk = state.repos.includes(r);
        return `<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:6px;cursor:pointer;">
              <input type="checkbox" data-asr="${esc(r)}" ${chk ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;">
              <i data-lucide="folder-git-2" style="width:13px;height:13px;color:var(--accent);flex-shrink:0;"></i>
              <span style="font:12px var(--font-ui);color:var(--text);">${esc(r)}</span>
            </label>`;
      }).join('') : '<div style="padding:12px 10px;color:var(--subtext0);font-size:11px;">All repos are already assigned to a space. Add more repos in Settings.</div>';
      bodyHtml = `
        <p style="font-size:11px;color:var(--subtext0);margin:0 0 10px;line-height:1.5;">Select which repos belong to this space. A repo can only belong to one space at a time.</p>
        <div style="max-height:240px;overflow-y:auto;border:1px solid var(--surface1);border-radius:var(--radius);padding:4px;">${items}</div>`;
    } else if (step === 3) {
      const items = pluginList.length ? pluginList.map(p => {
        const chk = state.plugins.includes(p.id);
        return `<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:6px;cursor:pointer;">
              <input type="checkbox" data-asp="${esc(p.id)}" ${chk ? 'checked' : ''} style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;">
              <i data-lucide="${esc(p.icon || 'puzzle')}" style="width:13px;height:13px;color:var(--accent);flex-shrink:0;"></i>
              <span style="font:12px var(--font-ui);color:var(--text);">${esc(p.name || p.id)}</span>
            </label>`;
      }).join('') : '<div style="padding:12px 10px;color:var(--subtext0);font-size:11px;">No plugins installed. Install plugins from Settings &rsaquo; Plugins.</div>';
      bodyHtml = `
        <p style="font-size:11px;color:var(--subtext0);margin:0 0 10px;line-height:1.5;">Choose which plugins are surfaced while this space is active. Leave all unchecked to show every plugin. Browser tools are always available and are not listed here.</p>
        <div style="max-height:240px;overflow-y:auto;border:1px solid var(--surface1);border-radius:var(--radius);padding:4px;">${items}</div>`;
    }
    const backBtn = step > 1 ? `<button onclick="window._asoBack()" style="display:inline-flex;align-items:center;gap:5px;padding:0 12px;height:30px;background:var(--surface1);border:1px solid var(--surface2);border-radius:var(--radius-lg);color:var(--text);font:600 12px var(--font-ui);cursor:pointer;">
          <i data-lucide="arrow-left" style="width:12px;height:12px;"></i> Back
        </button>` : '';
    const isLast = step === 3;
    const nextLabel = isLast ? isEdit ? 'Save' : 'Create Space' : 'Next';
    const nextArrow = isLast ? '' : ' <i data-lucide="arrow-right" style="width:12px;height:12px;"></i>';
    const headerTitle = isEdit ? 'Edit Space' + (originalName ? ': ' + esc(originalName) : '') : 'New Space';
    overlay.innerHTML = `
      <div style="background:var(--surface0);border:1px solid var(--surface2);border-radius:var(--radius-lg);padding:24px;width:390px;max-width:calc(100vw - 40px);box-shadow:0 16px 48px rgba(0,0,0,0.5);">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
          <i data-lucide="layers" style="width:16px;height:16px;color:var(--accent);"></i>
          <strong style="font-size:14px;color:var(--text);font-family:var(--font-ui);">${headerTitle}</strong>
          <div style="flex:1;"></div>
          <button onclick="window._asoDismiss()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:2px;display:flex;align-items:center;">
            <i data-lucide="x" style="width:14px;height:14px;"></i>
          </button>
        </div>
        <div style="display:flex;align-items:center;margin-bottom:20px;">${stepDotsHtml}</div>
        <div>${bodyHtml}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:20px;">
          <button onclick="window._asoDismiss()" style="display:inline-flex;align-items:center;padding:0 12px;height:30px;background:transparent;border:1px solid transparent;border-radius:var(--radius-lg);color:var(--subtext0);font:500 12px var(--font-ui);cursor:pointer;">Cancel</button>
          <div style="flex:1;"></div>
          ${backBtn}
          <button onclick="window._asoNext()" style="display:inline-flex;align-items:center;gap:5px;padding:0 14px;height:30px;background:var(--accent);border:1px solid var(--accent);border-radius:var(--radius-lg);color:var(--crust);font:600 12px var(--font-ui);cursor:pointer;">${nextLabel}${nextArrow}</button>
        </div>
      </div>`;
    try {
      lucide.createIcons({
        nodes: [overlay]
      });
    } catch (_) {}
    overlay.querySelectorAll('[data-pick-icon]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.icon = btn.dataset.pickIcon;
        renderStep();
      });
    });
    if (step === 1) {
      setTimeout(() => {
        const el = document.getElementById('_asoName');
        if (el) el.focus();
      }, 30);
    }
  }
  window._asoNext = function () {
    if (step === 1) {
      state.name = (document.getElementById('_asoName')?.value || '').trim();
      state.description = (document.getElementById('_asoDesc')?.value || '').trim();
      if (!state.name) {
        const e = document.getElementById('_asoNameErr');
        if (e) e.style.display = '';
        return;
      }
      step = 2;
      renderStep();
    } else if (step === 2) {
      state.repos = [...overlay.querySelectorAll('[data-asr]:checked')].map(el => el.dataset.asr);
      step = 3;
      renderStep();
    } else if (step === 3) {
      state.plugins = [...overlay.querySelectorAll('[data-asp]:checked')].map(el => el.dataset.asp);
      _asoSubmit();
    }
  };
  window._asoBack = function () {
    if (step === 2) {
      state.repos = [...overlay.querySelectorAll('[data-asr]:checked')].map(el => el.dataset.asr);
      step = 1;
    } else if (step === 3) {
      state.plugins = [...overlay.querySelectorAll('[data-asp]:checked')].map(el => el.dataset.asp);
      step = 2;
    }
    renderStep();
  };
  window._asoDismiss = function () {
    overlay.remove();
    ['_asoNext', '_asoBack', '_asoDismiss'].forEach(k => delete window[k]);
  };
  async function _asoSubmit() {
    if (isEdit) {
      // Rename: delete old, create new carrying the chosen repos/plugins.
      // No rename: POST with all fields to upsert identity + plugins. Repos
      // go through /attach-repo so single-membership invariants are preserved.
      try {
        if (state.name !== originalName) {
          await fetch('/api/spaces', {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: originalName
            })
          });
          await fetch('/api/spaces', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: state.name,
              description: state.description,
              icon: state.icon,
              repos: state.repos,
              plugins: state.plugins
            })
          });
          if (window.state.activeSpace === originalName) {
            window.state.activeSpace = state.name;
            try {
              localStorage.setItem('symphonee-space', window.state.activeSpace);
            } catch (_) {}
          }
        } else {
          await fetch('/api/spaces', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: state.name,
              description: state.description,
              icon: state.icon,
              plugins: state.plugins
            })
          });
          const before = new Set(originalRepos);
          const after = new Set(state.repos);
          const added = [...after].filter(r => !before.has(r));
          const removed = [...before].filter(r => !after.has(r));
          for (const repo of added) {
            await fetch('/api/spaces/attach-repo', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                space: state.name,
                repo,
                attach: true
              })
            });
          }
          for (const repo of removed) {
            await fetch('/api/spaces/attach-repo', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                space: state.name,
                repo,
                attach: false
              })
            });
          }
        }
        toast('Space updated', 'success');
      } catch (e) {
        toast('Failed to update space: ' + (e.message || String(e)), 'error');
        return;
      }
    } else {
      const res = await fetch('/api/spaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: state.name,
          description: state.description,
          icon: state.icon,
          repos: state.repos,
          plugins: state.plugins
        })
      });
      if (!res.ok) {
        toast('Failed to create space', 'error');
        return;
      }
      toast('Space "' + state.name + '" created', 'success');
    }
    overlay.remove();
    ['_asoNext', '_asoBack', '_asoDismiss'].forEach(k => delete window[k]);
    try {
      loadRepoList();
    } catch (_) {}
    try {
      _refreshSpaceSwitcher();
    } catch (_) {}
    try {
      renderSettingsSpaces();
    } catch (_) {}
  }
  renderStep();
}
async function openEditSpaceDialog(name) {
  const spaces = await fetch('/api/spaces').then(r => r.json()).catch(() => ({}));
  const existing = spaces[name] || {};
  await openAddSpaceDialog({
    edit: true,
    name,
    description: existing.description || '',
    icon: existing.icon || 'layers',
    repos: Array.isArray(existing.repos) ? existing.repos : [],
    plugins: Array.isArray(existing.plugins) ? existing.plugins : []
  });
}
async function deleteSpace(name) {
  if (!name) return;
  const confirmed = await customConfirm('Delete Space', 'Delete space "' + name + '"? Repos inside it are not affected.', 'Delete');
  if (!confirmed) return;
  const res = await fetch('/api/spaces', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name
    })
  });
  if (!res.ok) {
    toast('Failed to delete space', 'error');
    return;
  }
  toast('Space removed', 'success');
  if (state.activeSpace === name) {
    state.activeSpace = '';
    try {
      localStorage.removeItem('symphonee-space');
    } catch (_) {}
  }
  try {
    loadRepoList();
  } catch (_) {}
  try {
    _refreshSpaceSwitcher();
  } catch (_) {}
  try {
    renderSettingsSpaces();
  } catch (_) {}
}
// Settings-modal Spaces section renderer.
async function renderSettingsSpaces() {
  const host = document.getElementById('settingsSpacesList');
  if (!host) return;
  let spaces = {};
  try {
    spaces = await fetch('/api/spaces').then(r => r.json());
  } catch (_) {}
  const names = Object.keys(spaces || {});
  if (!names.length) {
    host.innerHTML = '<div style="font-size:11px;color:var(--subtext0);padding:10px 12px;background:var(--surface0);border:1px dashed var(--surface2);border-radius:var(--radius);">No spaces yet. Use "Add Space" to create one.</div>';
    return;
  }
  host.innerHTML = names.map(function (n) {
    const s = spaces[n] || {};
    const icon = s.icon || 'layers';
    const repoCount = (s.repos || []).length;
    const desc = s.description ? String(s.description) : '';
    return '<div class="settings-space-row" style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface0);border:1px solid var(--surface1);border-radius:var(--radius);margin-bottom:6px;">' + '<i data-lucide="' + esc(icon) + '" style="width:14px;height:14px;color:var(--accent);flex-shrink:0;"></i>' + '<div style="flex:1;min-width:0;">' + '<div style="font-size:12px;font-weight:600;color:var(--text);">' + esc(n) + '</div>' + '<div style="font-size:10px;color:var(--subtext0);">' + repoCount + ' repo' + (repoCount === 1 ? '' : 's') + (desc ? ' &middot; ' + esc(desc) : '') + '</div>' + '</div>' + '<button class="modal-btn" onclick="openEditSpaceDialog(' + JSON.stringify(n).replace(/"/g, '&quot;') + ')" style="padding:4px 10px;font-size:10px;">Edit</button>' + '<button class="modal-btn" onclick="deleteSpace(' + JSON.stringify(n).replace(/"/g, '&quot;') + ')" style="padding:4px 10px;font-size:10px;color:var(--red);">Delete</button>' + '</div>';
  }).join('');
  try {
    lucide.createIcons({
      nodes: [host]
    });
  } catch (_) {}
}

// ── Space / repo switcher (header chip) ─────────────────────────────────
async function _refreshSpaceSwitcher() {
  const spaceLabel = document.getElementById('spaceSwitcherLabel');
  const spaceChip = document.getElementById('spaceSwitcherChip');
  const repoChip = document.getElementById('repoChip');
  const repoLabel = document.getElementById('repoChipLabel');
  if (!spaceLabel || !spaceChip) return;
  let spaces = {},
    repos = {};
  try {
    [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
  } catch (_) {}
  // Space row: show active space name or fallback
  spaceLabel.textContent = state.activeSpace || 'All spaces';
  // Space icon: custom space icon or default layers
  let iconName = 'layers';
  if (state.activeSpace && spaces[state.activeSpace] && spaces[state.activeSpace].icon) iconName = spaces[state.activeSpace].icon;
  const iconEl = document.getElementById('spaceChipIcon');
  if (iconEl) {
    iconEl.setAttribute('data-lucide', iconName);
    try {
      lucide.createIcons({
        nodes: [spaceChip]
      });
    } catch (_) {}
  }
  // Repo row: show when a space is selected (to allow repo picking), when
  // a repo is active, or whenever any repos exist so the user can pick one
  // from "All spaces" without having to create a space first.
  // Always show the repo chip -- a brand-new user with zero repos needs a way
  // in. When nothing is added yet it reads "+ Add repo"; the picker it opens now
  // offers an "Add a repo" action even when the list is empty.
  const hasAnyRepo = Object.keys(repos).length > 0;
  if (repoChip) repoChip.style.display = '';
  if (repoLabel) repoLabel.textContent = state.activeRepo || (hasAnyRepo ? 'Select repo' : '+ Add repo');
  const menu = document.getElementById('spaceSwitcherMenu');
  if (menu && menu.classList.contains('open')) _renderSpaceSwitcherMenu(spaces, repos);
}
async function toggleSpaceSwitcher(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('spaceSwitcherMenu');
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', willOpen);
  if (willOpen) {
    const [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
    _renderSpaceSwitcherMenu(spaces, repos);
  }
}
function _renderSpaceSwitcherMenu(spaces, repos) {
  const menu = document.getElementById('spaceSwitcherMenu');
  if (!menu) return;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const spaceNames = Object.keys(spaces || {});
  const repoNames = Object.keys(repos || {});

  // Bucket repos by their parent space; everything else goes in "unassigned".
  const spaceRepos = {};
  const unassigned = [];
  for (const n of spaceNames) {
    const list = spaces[n] && Array.isArray(spaces[n].repos) ? spaces[n].repos : [];
    spaceRepos[n] = list.filter(r => repoNames.includes(r));
  }
  const inSomeSpace = new Set(Object.values(spaceRepos).flat());
  for (const r of repoNames) if (!inSomeSpace.has(r)) unassigned.push(r);

  // Render a single repo row (with a "REPO" type badge).
  const repoRow = (rName, nested) => {
    const active = rName === state.activeRepo ? ' active' : '';
    const pad = nested ? 'padding-left:26px;margin-left:10px;' : '';
    return '<div class="space-menu-item' + active + '" data-select-repo="' + esc(rName) + '" data-repo-name="' + esc(rName) + '" style="' + pad + '" title="Right-click to move to another space">' + '<i class="sm-icon" data-lucide="folder-git-2" style="width:13px;height:13px;"></i>' + '<div class="sm-label">' + esc(rName) + '</div>' + '<span style="font-size:9px;font-weight:600;color:var(--overlay1);letter-spacing:0.4px;flex-shrink:0;margin-left:6px;">REPO</span>' + '</div>';
  };

  // Render a space row (and its children indented beneath it).
  const spaceBlock = sName => {
    const sv = spaces[sName] || {};
    const active = sName === state.activeSpace ? ' active' : '';
    const icon = sv.icon || 'layers';
    const desc = sv.description || '';
    const kids = spaceRepos[sName] || [];
    const head = '<div class="space-menu-item' + active + '" data-select-space="' + esc(sName) + '">' + '<i class="sm-icon" data-lucide="' + esc(icon) + '" style="width:13px;height:13px;"></i>' + '<div class="sm-label">' + esc(sName) + (kids.length ? '<span style="color:var(--subtext0);font-weight:400;"> · ' + kids.length + '</span>' : '') + '</div>' + (desc ? '<span style="font-size:9px;color:var(--subtext0);">' + esc(desc) + '</span>' : '') + '<span style="font-size:9px;font-weight:600;color:var(--accent);letter-spacing:0.4px;flex-shrink:0;opacity:0.7;margin-left:6px;">SPACE</span>' + '<button class="sm-gear" data-manage-space="' + esc(sName) + '" title="Space settings"><i data-lucide="settings" style="width:11px;height:11px;"></i></button>' + '<button class="sm-del" data-del-space="' + esc(sName) + '" title="Delete space"><i data-lucide="x" style="width:11px;height:11px;"></i></button>' + '</div>';
    return head + kids.map(r => repoRow(r, true)).join('');
  };
  const noneItem = '<div class="space-menu-item' + (!state.activeSpace ? ' active' : '') + '" data-select-space="">' + '<i class="sm-icon" data-lucide="layers" style="width:13px;height:13px;"></i>' + '<div class="sm-label">All spaces</div></div>';
  const noRepoItem = '<div class="space-menu-item' + (!state.activeRepo ? ' active' : '') + '" data-select-repo="" data-repo-name="">' + '<i class="sm-icon" data-lucide="folder-x" style="width:13px;height:13px;"></i>' + '<div class="sm-label">No repo</div>' + '<span style="font-size:9px;font-weight:600;color:var(--overlay1);letter-spacing:0.4px;flex-shrink:0;margin-left:6px;">REPO</span>' + '</div>';
  const spacesBlockHtml = spaceNames.length ? '<div class="space-menu-section">Spaces</div>' + spaceNames.map(spaceBlock).join('') : '';

  // When no space is active, show ALL repos (including those in spaces).
  // When inside a space, repos are shown nested under the space block, so the
  // flat list stays empty. "No repo" always renders as the first item so the
  // user can clear the repo selection for work that isn't tied to a repository.
  let repoListHtml = '';
  if (!state.activeSpace && repoNames.length) repoListHtml = repoNames.map(r => repoRow(r, false)).join('');else if (!state.activeSpace && unassigned.length) repoListHtml = unassigned.map(r => repoRow(r, false)).join('');
  const allReposHtml = '<div class="space-menu-section">Repos</div>' + noRepoItem + repoListHtml;
  const body = '<div class="space-menu-body">' + noneItem + spacesBlockHtml + allReposHtml + (!spaceNames.length && !repoNames.length ? '<div class="space-menu-empty">No spaces or repos yet. Create one below.</div>' : '') + '</div>';
  const footer = '<div class="space-menu-footer">' + '<button onclick="(async()=>{document.getElementById(\'spaceSwitcherMenu\').classList.remove(\'open\');await openAddSpaceDialog();})()"><i data-lucide="layers" style="width:12px;height:12px;"></i>New space</button>' + '<button onclick="document.getElementById(\'spaceSwitcherMenu\').classList.remove(\'open\');openSettings(\'repos\');"><i data-lucide="plus" style="width:12px;height:12px;"></i>Add repo</button>' + (state.activeSpace ? '<button onclick="document.getElementById(\'spaceSwitcherMenu\').classList.remove(\'open\');openManageSpaceDialog(\'' + esc(state.activeSpace) + '\');"><i data-lucide="settings" style="width:12px;height:12px;"></i>Manage</button>' : '') + '</div>';
  menu.innerHTML = body + footer;
  menu.querySelectorAll('[data-select-space]').forEach(el => {
    el.addEventListener('click', ev => {
      if (ev.target.closest('.sm-del')) return;
      if (ev.target.closest('.sm-gear')) return;
      const name = el.dataset.selectSpace || '';
      selectSpace(name);
      menu.classList.remove('open');
    });
  });
  menu.querySelectorAll('.sm-gear').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const name = btn.dataset.manageSpace;
      if (!name) return;
      menu.classList.remove('open');
      openManageSpaceDialog(name);
    });
  });
  menu.querySelectorAll('[data-select-repo]').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.selectRepo;
      selectRepo(name);
      menu.classList.remove('open');
    });
    el.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      _openMoveRepoPopover(el.dataset.repoName, ev.clientX, ev.clientY, spaces);
    });
  });
  menu.querySelectorAll('.sm-del').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      deleteSpace(btn.dataset.delSpace);
    });
  });
  try {
    lucide.createIcons({
      nodes: [menu]
    });
  } catch (_) {}
}
// Close on outside click
document.addEventListener('click', e => {
  const menu = document.getElementById('spaceSwitcherMenu');
  const chip = document.getElementById('spaceSwitcherChip');
  if (!menu || !menu.classList.contains('open')) return;
  if (chip && chip.contains(e.target)) return;
  if (menu.contains(e.target)) return;
  menu.classList.remove('open');
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(_refreshSpaceSwitcher, 200);
});

// ── Repos & Spaces ──────────────────────────────────────────────────────
// Two independent active slots: activeSpace is the organizational container
// (Business, Personal, ...); activeRepo is the working repo within it. A
// repo can belong to at most one space; "No space" mode shows unassigned
// repos only.
state.activeSpace = localStorage.getItem('symphonee-space') || '';
state.activeRepo = localStorage.getItem('symphonee-repo') || '';
function _repoNamesForSpace(repos, spaces, spaceName) {
  const repoNames = Object.keys(repos || {});
  if (!spaceName) return repoNames;
  const members = spaces && spaces[spaceName] && Array.isArray(spaces[spaceName].repos) ? spaces[spaceName].repos : [];
  return members.filter(r => Object.prototype.hasOwnProperty.call(repos || {}, r));
}
async function loadRepoList() {
  try {
    const [repos, spaces] = await Promise.all([fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/spaces').then(r => r.json()).catch(() => ({}))]);
    window._spacesCache = spaces || {};
    if (state.configData) {
      state.configData.Repos = repos || {};
      state.configData.Spaces = spaces || {};
    }
    const repoNames = Object.keys(repos);
    const spaceNames = Object.keys(spaces);

    // Legacy migration: before dual-state, activeRepo held either a space
    // name or a repo name. Split them into their proper slots - but ONLY
    // when the name is a space that isn't also a real repo. Without the
    // repoNames guard, a user whose repo and space share a name (e.g. both
    // "Symphonee") would get their repo silently wiped every refresh.
    if (state.activeRepo && spaces[state.activeRepo] && !repoNames.includes(state.activeRepo)) {
      state.activeSpace = state.activeRepo;
      state.activeRepo = '';
      localStorage.setItem('symphonee-space', state.activeSpace);
      localStorage.removeItem('symphonee-repo');
    }

    // Validate saved values still exist
    if (state.activeSpace && !spaces[state.activeSpace]) {
      state.activeSpace = '';
      localStorage.removeItem('symphonee-space');
    }
    if (state.activeRepo && !repoNames.includes(state.activeRepo)) {
      state.activeRepo = '';
      localStorage.removeItem('symphonee-repo');
    }
    const activeSpaceRepos = _repoNamesForSpace(repos, spaces, state.activeSpace);
    if (state.activeSpace && state.activeRepo && !activeSpaceRepos.includes(state.activeRepo)) {
      state.activeRepo = '';
      state.filesCurrentRepo = '';
      localStorage.removeItem('symphonee-repo');
    }
    if (state.activeSpace && !state.activeRepo && activeSpaceRepos.length === 1) {
      state.activeRepo = activeSpaceRepos[0];
      state.filesCurrentRepo = state.activeRepo;
      localStorage.setItem('symphonee-repo', state.activeRepo);
    }

    // If an activeRepo is set and belongs to a space, snap to that space on
    // very first boot only (i.e. when the user has no stored space preference
    // at all). After that, spaces and repos are fully independent - an
    // explicit "All spaces" choice (stored as "") must survive reloads.
    if (state.activeRepo && !loadRepoList._snappedOwnerOnce && localStorage.getItem('symphonee-space') === null) {
      const owner = _findSpaceForRepo(spaces, state.activeRepo);
      if (owner && owner !== state.activeSpace) {
        state.activeSpace = owner;
        localStorage.setItem('symphonee-space', state.activeSpace);
      }
    }
    loadRepoList._snappedOwnerOnce = true;
    if (state.activeRepo) state.filesCurrentRepo = state.activeRepo;
    if (!state.activeRepo && state.filesCurrentRepo) state.filesCurrentRepo = '';
    try {
      populateFilesRepoSelect();
    } catch (_) {}

    // Keep the header chip in sync.
    try {
      _refreshSpaceSwitcher();
    } catch (_) {}
    lucide.createIcons();

    // On startup, if we have a saved repo, fetch+pull and load git status
    if (state.activeRepo && !loadRepoList._initialized) {
      loadRepoList._initialized = true;
      fetchAndPullOnStartup(state.activeRepo);
      loadGitStatusForDiffTab(state.activeRepo);
    }
    // Hide git actions when no repo selected (spaces alone have no git).
    const gitActions = document.getElementById('sidebarGitActions');
    if (gitActions) gitActions.style.display = state.activeRepo ? '' : 'none';
    pushUiContext();
    loadTerminalScripts();
  } catch (_) {}
}

// Find which space (if any) contains a given repo name.
function _findSpaceForRepo(spaces, repoName) {
  if (!spaces || !repoName) return null;
  for (const [name, s] of Object.entries(spaces)) {
    if (s && Array.isArray(s.repos) && s.repos.includes(repoName)) return name;
  }
  return null;
}
async function fetchRepoSidebarBranch(repoName) {
  try {
    const res = await fetch(`/api/git/branches?repo=${encodeURIComponent(repoName)}`);
    const data = await res.json();
    const el = document.getElementById('repoSidebarBranch');
    if (el && data.current) el.textContent = data.current;
  } catch (_) {}
}
async function fetchAndPullOnStartup(repoName) {
  try {
    // Only pull if the working tree is clean (don't risk conflicts with uncommitted changes)
    const statusRes = await fetch(`/api/git/status?repo=${encodeURIComponent(repoName)}`);
    const statusData = await statusRes.json();
    if (statusData.files && statusData.files.length > 0) return; // dirty - skip pull

    const res = await fetch('/api/git/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        repo: repoName
      })
    });
    const data = await res.json();
    if (data.ok && data.message && data.message !== 'Already up to date.') {
      toast('Pulled latest changes for ' + repoName, 'info');
    }
    // Refresh sidebar branch and diff tab after pull
    fetchRepoSidebarBranch(repoName);
    loadGitStatusForDiffTab(repoName);
  } catch (_) {}
}
async function loadGitStatusForDiffTab(repoName) {
  try {
    const res = await fetch(`/api/git/status?repo=${encodeURIComponent(repoName)}`);
    const git = await res.json();
    // Update sidebar branch display
    if (!git.error && git.branch) {
      const el = document.getElementById('repoSidebarBranch');
      if (el) el.textContent = git.branch;
      // Keep the header branch chip in sync when the branch changes outside the UI
      // (e.g. a terminal checkout). Only touch the chip for the active repo.
      if (repoName === state.activeRepo) {
        const chipLabel = document.getElementById('branchChipLabel');
        if (chipLabel && chipLabel.textContent !== git.branch) _setBranchChip(git.branch);
      }
    }
    if (!git.error && git.files && git.files.length > 0) {
      document.getElementById('diffviewTabBtn').style.display = '';
      populateDiffTabWithChanges(git.files, repoName);
    } else {
      // Hide diff tab if no changes (unless viewing a commit diff)
      if (!state.diffViewCommit || state.diffViewCommit.hash === 'working') {
        document.getElementById('diffviewTabBtn').style.display = 'none';
      }
    }
  } catch (_) {}
}

// Poll git status every 10s to auto-show/hide the diff tab
state._gitPollTimer = null;
function startGitStatusPolling() {
  if (state._gitPollTimer) clearInterval(state._gitPollTimer);
  state._gitPollTimer = setInterval(() => {
    const repo = state.activeRepo || state.filesCurrentRepo;
    if (repo) loadGitStatusForDiffTab(repo);
  }, 10000);
}
startGitStatusPolling();
function selectRepo(name) {
  state.activeRepo = name;
  state.filesCurrentRepo = name;

  // Spaces and repos are independent selections. Picking a repo from "All
  // spaces" (or from a different space) must NOT auto-switch the space --
  // that forced users out of All-spaces mode whenever they chose a repo
  // that happened to belong to a space.

  try {
    _refreshSpaceSwitcher();
  } catch (_) {}
  try {
    refreshBranchChip();
  } catch (_) {}
  const gitActions = document.getElementById('sidebarGitActions');
  if (!name) {
    localStorage.removeItem('symphonee-repo');
    if (gitActions) gitActions.style.display = 'none';
    const scriptsBar = document.getElementById('filesScriptsBar');
    if (scriptsBar) scriptsBar.style.display = 'none';
    const termBar = document.getElementById('termScriptsBar');
    if (termBar) termBar.style.display = 'none';
  } else {
    localStorage.setItem('symphonee-repo', name);
    if (gitActions) gitActions.style.display = '';
  }
  loadRepoList();

  // Sync files tab repo selector
  const select = document.getElementById('filesRepoSelect');
  if (select) select.value = name;

  // Sync work item tab "Start Working" repo selector
  const startWorkSelect = document.getElementById('startWorkRepo');
  if (startWorkSelect && name) startWorkSelect.value = name;
  if (name) {
    loadFileTree('');
    loadGitLogPanel();
    loadProjectScripts();
  }
  loadTerminalScripts();

  // Sync PR tab repo selector and reload PRs if on that tab
  const prSelect = document.getElementById('prsRepoSelect');
  if (prSelect) {
    prSelect.value = name;
    state.prsCurrentRepo = name;
  }
  if (name && document.getElementById('panel-prs')?.classList.contains('active')) {
    loadPRs();
  }
  pushUiContext();
  notifyPluginIframes('repoChanged', {
    repo: name || null
  });
  try {
    refreshNotesForSpace();
  } catch (_) {}
  try {
    applyPluginSpaceFilter();
  } catch (_) {}
}

// Small popover anchored at (x, y) for moving a repo into (or out of) a space.
// Writes via /api/spaces/attach-repo which enforces single-space membership.
function _openMoveRepoPopover(repoName, x, y, spaces) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  document.getElementById('moveRepoPopover')?.remove();
  const currentOwner = _findSpaceForRepo(spaces, repoName);
  const pop = document.createElement('div');
  pop.id = 'moveRepoPopover';
  pop.style.cssText = 'position:fixed;z-index:9500;min-width:200px;max-height:300px;overflow:auto;background:var(--surface0);border:1px solid var(--surface2);border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,0.5);padding:4px;font:12px var(--font-ui);';
  const spaceNames = Object.keys(spaces || {});
  const header = '<div style="padding:6px 10px;color:var(--subtext0);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;">Move ' + esc(repoName) + ' to</div>';
  const items = spaceNames.map(n => {
    const isCurrent = n === currentOwner;
    return '<div class="mrp-item" data-target="' + esc(n) + '" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:4px;cursor:pointer;' + (isCurrent ? 'color:var(--accent);' : '') + '" onmouseover="this.style.background=\'var(--surface1)\'" onmouseout="this.style.background=\'\'">' + '<i data-lucide="' + esc(spaces[n] && spaces[n].icon || 'layers') + '" style="width:13px;height:13px;"></i>' + '<span style="flex:1;">' + esc(n) + '</span>' + (isCurrent ? '<i data-lucide="check" style="width:12px;height:12px;"></i>' : '') + '</div>';
  }).join('');
  const unassign = currentOwner ? '<div style="border-top:1px solid var(--surface1);margin:4px 0;"></div>' + '<div class="mrp-item" data-target="" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:4px;cursor:pointer;color:var(--subtext0);" onmouseover="this.style.background=\'var(--surface1)\'" onmouseout="this.style.background=\'\'">' + '<i data-lucide="minus-circle" style="width:13px;height:13px;"></i>' + '<span>Unassign (remove from ' + esc(currentOwner) + ')</span>' + '</div>' : '';
  pop.innerHTML = header + items + unassign;
  document.body.appendChild(pop);
  // Keep inside viewport
  const rect = pop.getBoundingClientRect();
  const vw = window.innerWidth,
    vh = window.innerHeight;
  pop.style.left = Math.min(x, vw - rect.width - 8) + 'px';
  pop.style.top = Math.min(y, vh - rect.height - 8) + 'px';
  try {
    lucide.createIcons({
      nodes: [pop]
    });
  } catch (_) {}
  pop.querySelectorAll('.mrp-item').forEach(row => {
    row.addEventListener('click', async () => {
      const target = row.dataset.target;
      try {
        const r = await fetch('/api/spaces/attach-repo', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            space: target || currentOwner || '',
            repo: repoName,
            attach: target !== '' // empty target = detach from current
          })
        });
        if (!r.ok) throw new Error(await r.text().catch(() => 'HTTP ' + r.status));
        pop.remove();
        toast(target ? 'Moved ' + repoName + ' to ' + target : 'Unassigned ' + repoName, 'success');
        // Refresh the switcher menu if still open, and the sidebar list.
        try {
          _refreshSpaceSwitcher();
        } catch (_) {}
        try {
          loadRepoList();
        } catch (_) {}
      } catch (err) {
        toast('Move failed: ' + (err.message || err), 'error');
      }
    });
  });

  // Close on outside click / escape.
  const closer = ev => {
    if (!pop.contains(ev.target)) {
      pop.remove();
      document.removeEventListener('mousedown', closer);
      document.removeEventListener('keydown', keyCloser);
    }
  };
  const keyCloser = ev => {
    if (ev.key === 'Escape') {
      pop.remove();
      document.removeEventListener('mousedown', closer);
      document.removeEventListener('keydown', keyCloser);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closer), 0);
  document.addEventListener('keydown', keyCloser);
}

// Manage a space: edit description/icon, pick which repos belong to it, and
// choose which plugins are surfaced while this space is active. Opens over the
// main UI and writes changes through /api/spaces and /api/spaces/*.
async function openManageSpaceDialog(name) {
  if (!name) return;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let spaces = {},
    repos = {},
    plugins = [];
  try {
    [spaces, repos, plugins] = await Promise.all([fetch('/api/spaces').then(r => r.json()).catch(() => ({})), fetch('/api/repos').then(r => r.json()).catch(() => ({})), fetch('/api/plugins').then(r => r.json()).catch(() => [])]);
  } catch (_) {}
  const s = spaces[name] || {};
  const repoNames = Object.keys(repos);
  const pluginList = (Array.isArray(plugins) ? plugins : []).filter(p => p && !isCoreSpacePluginId(p.id));
  const toggle = (dataAttr, val, checked) => '<label class="ms-toggle"><input type="checkbox" ' + dataAttr + '="' + esc(val) + '"' + (checked ? ' checked' : '') + '><span class="ms-toggle-track"></span></label>';
  const reposHtml = repoNames.length ? repoNames.map(r => {
    const on = (s.repos || []).includes(r);
    let owner = null;
    for (const [n, other] of Object.entries(spaces)) {
      if (n === name) continue;
      if (other && Array.isArray(other.repos) && other.repos.includes(r)) {
        owner = n;
        break;
      }
    }
    return '<div class="ms-row">' + toggle('data-ms-repo', r, on) + '<i data-lucide="folder-git-2" style="width:13px;height:13px;color:var(--subtext0);flex-shrink:0;"></i>' + '<span class="ms-row-label">' + esc(r) + '</span>' + (owner ? '<span class="ms-row-sub">in ' + esc(owner) + '</span>' : '') + '</div>';
  }).join('') : '<div style="color:var(--subtext0);font-size:11px;padding:10px 2px;">No repos configured.</div>';
  const pluginsHtml = pluginList.length ? pluginList.map(p => {
    const on = (s.plugins || []).includes(p.id);
    return '<div class="ms-row">' + toggle('data-ms-plugin', p.id, on) + '<i data-lucide="' + esc(p.icon || 'puzzle') + '" style="width:13px;height:13px;color:var(--subtext0);flex-shrink:0;"></i>' + '<span class="ms-row-label">' + esc(p.name || p.id) + '</span>' + '</div>';
  }).join('') : '<div style="color:var(--subtext0);font-size:11px;padding:10px 2px;">No plugins installed.</div>';
  let overlay = document.getElementById('manageSpaceOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'manageSpaceOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:4000;display:flex;align-items:center;justify-content:center;font-family:var(--font-ui);';
  overlay.onclick = e => {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML = '<div class="ms-dialog">' + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-shrink:0;">' + '<i data-lucide="' + esc(s.icon || 'layers') + '" style="width:18px;height:18px;color:var(--accent);"></i>' + '<strong style="font-size:14px;">' + esc(name) + '</strong>' + '<div style="flex:1;"></div>' + '<button onclick="document.getElementById(\'manageSpaceOverlay\').remove()" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;padding:4px;border-radius:4px;" onmouseover="this.style.color=\'var(--text)\'" onmouseout="this.style.color=\'var(--subtext0)\'"><i data-lucide="x" style="width:14px;height:14px;"></i></button>' + '</div>' + '<div class="ms-tabs">' + '<button class="ms-tab active" data-ms-tab="repos" onclick="_msSwitchTab(this,\'repos\')">' + '<i data-lucide="folder-git-2" style="width:12px;height:12px;"></i>Repos' + '</button>' + '<button class="ms-tab" data-ms-tab="plugins" onclick="_msSwitchTab(this,\'plugins\')">' + '<i data-lucide="puzzle" style="width:12px;height:12px;"></i>Plugins' + '</button>' + '</div>' + '<div class="ms-tab-panel active" id="msTabRepos">' + '<div class="ms-list">' + reposHtml + '</div>' + '<div class="ms-tab-hint">A repo can only belong to one space at a time.</div>' + '</div>' + '<div class="ms-tab-panel" id="msTabPlugins">' + '<div class="ms-list">' + pluginsHtml + '</div>' + '<div class="ms-tab-hint">Leave all off to surface every installed plugin while this space is active. Browser tools remain available even when not listed here.</div>' + '</div>' + '<div style="display:flex;gap:8px;margin-top:16px;flex-shrink:0;">' + '<div style="flex:1;"></div>' + '<button class="sy-btn sy-btn-secondary" onclick="document.getElementById(\'manageSpaceOverlay\').remove()">Cancel</button>' + '<button class="sy-btn sy-btn-primary" onclick="_saveManageSpace(\'' + esc(name) + '\')">Save</button>' + '</div>' + '</div>';
  document.body.appendChild(overlay);
  try {
    lucide.createIcons({
      nodes: [overlay]
    });
  } catch (_) {}

  // Wire toggle rows: clicking the row fires the hidden checkbox
  overlay.querySelectorAll('.ms-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.ms-toggle')) return;
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = !cb.checked;
    });
  });
}
function _msSwitchTab(btn, tab) {
  const overlay = document.getElementById('manageSpaceOverlay');
  if (!overlay) return;
  overlay.querySelectorAll('.ms-tab').forEach(t => t.classList.toggle('active', t.dataset.msTab === tab));
  overlay.querySelectorAll('.ms-tab-panel').forEach(p => p.classList.toggle('active', p.id === (tab === 'repos' ? 'msTabRepos' : 'msTabPlugins')));
}
async function _saveManageSpace(name) {
  const overlay = document.getElementById('manageSpaceOverlay');
  if (!overlay) return;
  const repos = [...overlay.querySelectorAll('[data-ms-repo]:checked')].map(el => el.dataset.msRepo);
  const plugins = [...overlay.querySelectorAll('[data-ms-plugin]:checked')].map(el => el.dataset.msPlugin);
  try {
    const r = await fetch('/api/spaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        repos,
        plugins
      })
    });
    if (!r.ok) throw new Error(await r.text().catch(() => 'HTTP ' + r.status));
    toast('Space updated', 'success');
    overlay.remove();
    loadRepoList();
    try {
      _refreshSpaceSwitcher();
    } catch (_) {}
    try {
      applyPluginSpaceFilter();
    } catch (_) {}
  } catch (err) {
    toast('Save failed: ' + (err.message || err), 'error');
  }
}

// Placeholders filled in by later tasks (notes/plugin scoping). Defined here
// so selectSpace/selectRepo can call them without throwing before they're
// fully wired up.
function refreshNotesForSpace() {
  // Close whatever note was open - it may belong to a different space now.
  try {
    state.currentNote = null;
    const title = document.getElementById('noteTitle');
    if (title) title.textContent = 'No note selected';
    const editor = document.getElementById('noteEditor');
    if (editor) editor.style.display = 'none';
    const preview = document.getElementById('notePreview');
    if (preview) preview.style.display = 'none';
    const empty = document.getElementById('noteEmpty');
    if (empty) empty.style.display = '';
  } catch (_) {}
  // Update the sidebar label so the user knows which space's notebook they're in.
  try {
    const lbl = document.getElementById('notesSpaceLabel');
    if (lbl) lbl.textContent = state.activeSpace ? 'Notes · ' + state.activeSpace : 'Notes';
  } catch (_) {}
  try {
    if (typeof loadNotesList === 'function') loadNotesList();
  } catch (_) {}
}
// Hide or show UI elements contributed by each plugin based on the active
// space's preset. A space with an empty plugins[] list shows everything (no
// filter). "No space" also shows everything. Elements opt in by carrying a
// data-plugin-id attribute; this walks the document and toggles their
// visibility via a shared CSS class.
async function applyPluginSpaceFilter() {
  let allowed = null; // null = no filter (show all)
  // Always refresh the shared spaces cache so other UI (e.g. the '+' tab menu)
  // can consult it synchronously.
  try {
    window._spacesCache = (await fetch('/api/spaces').then(r => r.json()).catch(() => ({}))) || {};
  } catch (_) {
    window._spacesCache = window._spacesCache || {};
  }
  if (state.activeSpace) {
    const spaces = window._spacesCache;
    const preset = (spaces[state.activeSpace] && Array.isArray(spaces[state.activeSpace].plugins) ? spaces[state.activeSpace].plugins : []).filter(id => !isCoreSpacePluginId(id));
    if (preset.length) {
      allowed = new Set(preset);
      CORE_SPACE_PLUGIN_IDS.forEach(id => allowed.add(id));
    }
  }
  document.querySelectorAll('[data-plugin-id]').forEach(el => {
    const id = el.getAttribute('data-plugin-id');
    const hide = allowed && !allowed.has(id);
    el.classList.toggle('plugin-space-hidden', !!hide);
  });
  // Filtering the currently-active tab into hiding would strand the user on a
  // blank page - fall back to terminal if that happens.
  const active = document.querySelector('.tab-btn.active');
  if (active && active.classList.contains('plugin-space-hidden')) {
    try {
      switchTab('terminal');
    } catch (_) {}
  }
  // Re-evaluate section title visibility now that buttons may have been hidden.
  try {
    reconcilePluginShellSurfaces();
  } catch (_) {}
}

// Switch the active space. If the new space has a single repo, auto-select
// it; otherwise clear activeRepo so the user can pick one explicitly.
async function selectSpace(name) {
  state.activeSpace = name || '';
  // Always store the choice (even "" for "All spaces") so the preference
  // survives reloads. A missing key means "never chose", which triggers the
  // first-boot snap-to-owner-space; "" means the user explicitly opted out.
  localStorage.setItem('symphonee-space', state.activeSpace);

  // If the currently-active repo doesn't belong to the new space, clear it.
  try {
    const spaces = await fetch('/api/spaces').then(r => r.json()).catch(() => ({}));
    const members = spaces[state.activeSpace] && Array.isArray(spaces[state.activeSpace].repos) ? spaces[state.activeSpace].repos : [];
    if (state.activeRepo && !members.includes(state.activeRepo)) {
      // Clear the repo when leaving its space (unless going to "No space",
      // in which case unassigned repos are still valid).
      if (state.activeSpace) {
        state.activeRepo = '';
        state.filesCurrentRepo = '';
        localStorage.removeItem('symphonee-repo');
      }
    }
    // Auto-select if the space has exactly one repo and none is active.
    if (state.activeSpace && !state.activeRepo && members.length === 1) {
      selectRepo(members[0]);
      return;
    }
  } catch (_) {}
  try {
    _refreshSpaceSwitcher();
  } catch (_) {}
  loadRepoList();
  pushUiContext();
  try {
    refreshNotesForSpace();
  } catch (_) {}
  try {
    applyPluginSpaceFilter();
  } catch (_) {}
  // Reset orchestrator scope default for the new space and re-fetch.
  try {
    const el = document.getElementById('orchScopeFilter');
    if (el) delete el.dataset.userTouched;
    syncOrchScopeFilter();
    if (typeof orchRefreshTasks === 'function') orchRefreshTasks();
  } catch (_) {}
  notifyPluginIframes('spaceChanged', {
    space: state.activeSpace || null
  });
}

// ── Public surface ──────────────────────────────────────────────────────────
// Reached from parts, index.html, the extracted modules (selectRepo/selectSpace/
// openEditSpaceDialog/_repoNamesForSpace), and generated onclick. The space
// switcher/popover/polling helpers stay private (openAddSpaceDialog's _aso*
// wizard handlers are local to it). CORE_SPACE_PLUGIN_IDS is used by plugins.js.
window.isCoreSpacePluginId = isCoreSpacePluginId;
window.openAddSpaceDialog = openAddSpaceDialog;
window.openEditSpaceDialog = openEditSpaceDialog;
window.deleteSpace = deleteSpace;
window.renderSettingsSpaces = renderSettingsSpaces;
window._repoNamesForSpace = _repoNamesForSpace;
window.loadRepoList = loadRepoList;
window.loadGitStatusForDiffTab = loadGitStatusForDiffTab;
window.selectRepo = selectRepo;
window.selectSpace = selectSpace;
window._msSwitchTab = _msSwitchTab;
window._saveManageSpace = _saveManageSpace;
window.applyPluginSpaceFilter = applyPluginSpaceFilter;
window.CORE_SPACE_PLUGIN_IDS = CORE_SPACE_PLUGIN_IDS;