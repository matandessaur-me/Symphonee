// ── Config ──────────────────────────────────────────────────────────────
let _configLoaded = false;
async function loadConfig(autoSelectSprint) {
  try {
    const res = await fetch('/api/config');
    configData = await res.json();
    try { loadHotkeys(); } catch (_) {}
    try { applyInappBrowserAppearance(); } catch (_) {}
    document.getElementById('projectLabel').textContent = 'Settings';
    // Plugin presence drives shell visibility. Config keys are owned by plugins
    // now and the loader filters /api/plugins by activationConditions, so a plugin
    // appearing in _loadedPlugins implies its config is satisfied.
    const hasAdo = !!((_loadedPlugins || []).some(p => p.contributions && p.contributions.workItemProvider));
    const hasGh = !!((_loadedPlugins || []).some(p => p.contributions && p.contributions.prProvider));
    // Plugin-driven surfaces depend on _loadedPlugins, so this is also rerun
    // after plugin init completes to close the cold-start race.
    reconcilePluginShellSurfaces();
    // Left-column Git actions: only useful once a repo is selected.
    var _gitActionsEl = document.getElementById('sidebarGitActions');
    if (_gitActionsEl) {
      var _hasActiveRepo = configData.Repos && Object.keys(configData.Repos).length > 0;
      _gitActionsEl.style.display = _hasActiveRepo ? '' : 'none';
    }
    // Git modal: hide Pull/Push when no PAT (local ops like Branches/Commit/Compare still work)
    const hasPat = !!(configData.GitHubPAT && configData.GitHubPAT.trim());
    const gitAuthOk = (hasGh || hasPat);
    const gitPullBtn = document.getElementById('gitNavPull');
    const gitPushBtn = document.getElementById('gitNavPush');
    const gitNoPatHint = document.getElementById('gitNavNoPatHint');
    if (gitPullBtn) gitPullBtn.style.display = gitAuthOk ? '' : 'none';
    if (gitPushBtn) gitPushBtn.style.display = gitAuthOk ? '' : 'none';
    if (gitNoPatHint) gitNoPatHint.style.display = gitAuthOk ? 'none' : '';
    document.getElementById('orchestratorTabBtn').style.display = '';
    // Repo list is core, not ADO-specific; always load it.
    loadRepoList();
    if (hasAdo) {
      loadTeams();
      loadAreas();
      await loadIterations(autoSelectSprint);
      loadTeamMembers();
    }
    // Apply saved default CLI on first load
    if (!_configLoaded && configData.DefaultCli && CLI_CONFIG[configData.DefaultCli]) {
      switchCli(configData.DefaultCli);
      _configLoaded = true;
    }
    updateScreenHint();
  } catch (_) {}
}

// ── Iterations ──────────────────────────────────────────────────────────
async function loadIterations(autoSelectCurrent) {
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'iterationsRoute', {});
    if (!res) return;
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }
    const select = document.getElementById('sprintSelect');
    select.innerHTML = '<option value="">All Iterations</option>';
    let currentPath = '';
    let firstPath = '';
    for (const it of data) {
      const opt = document.createElement('option');
      opt.value = it.path;
      opt.textContent = it.name + (it.isCurrent ? ' (current)' : '');
      select.appendChild(opt);
      if (!firstPath) firstPath = it.path;
      if (it.isCurrent) currentPath = it.path;
    }
    // Default to "All Iterations" even when switching projects; user can pick a specific sprint manually.
    void autoSelectCurrent;
    void firstPath;
    await loadWorkItems(!!autoSelectCurrent);
    if (currentPath) {
      loadBurndown(currentPath);
      updateSprintCard(data.find(i => i.isCurrent));
    }
    pushUiContext();
  } catch (_) {}
}

function onSprintChange() {
  closedItemsLimit = 10; // reset pagination when switching iterations
  loadWorkItems();
  const path = document.getElementById('sprintSelect').value;
  if (path) loadBurndown(path);
  pushUiContext();
  const name = (document.getElementById('sprintSelect').selectedOptions[0] || {}).textContent || '';
  notifyPluginIframes('iterationChanged', { iteration: path, name: name });
}

function pushUiContext() {
  const sel = document.getElementById('sprintSelect');
  const areaSel = document.getElementById('areaSelect');
  const ctx = {
    selectedIteration: sel.value || null,
    selectedIterationName: sel.selectedOptions[0]?.textContent || 'All Iterations',
    selectedArea: areaSel?.value || null,
    selectedAreaName: areaSel?.selectedOptions[0]?.textContent?.trim() || 'Team Default',
    activeSpace: activeSpace || null,
    activeRepo: activeRepo || filesCurrentRepo || null,
  };
  fetch('/api/ui/context', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ctx)
  }).catch(() => {});
}

// Current notes namespace - what /api/notes calls should default to. '_global'
// when no space is active; the space's slugged name otherwise.
function currentNotesNs() {
  if (!activeSpace) return '_global';
  return String(activeSpace).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || '_global';
}

// Fetch wrapper that scopes notes API calls to the active space's namespace.
// Adds ns= to GET querystrings and injects ns into POST/PUT/DELETE bodies.
function notesFetch(url, init) {
  const ns = currentNotesNs();
  init = init || {};
  const method = (init.method || 'GET').toUpperCase();
  if (method === 'GET' || (method === 'DELETE' && !init.body)) {
    const sep = url.includes('?') ? '&' : '?';
    return fetch(url + sep + 'ns=' + encodeURIComponent(ns), init);
  }
  if (init.body && typeof init.body === 'string') {
    try {
      const obj = JSON.parse(init.body);
      if (obj && typeof obj === 'object' && obj.ns === undefined) {
        obj.ns = ns;
        init = { ...init, body: JSON.stringify(obj) };
      }
    } catch (_) {}
  }
  return fetch(url, init);
}

// ── Work Items ──────────────────────────────────────────────────────────
async function loadWorkItems(refresh = false) {
  const iteration = document.getElementById('sprintSelect').value;
  const area = document.getElementById('areaSelect')?.value || '';
  const params = new URLSearchParams();
  if (iteration) params.set('iteration', iteration);
  if (area) params.set('area', area);
  if (refresh) params.set('refresh', '1');
  params.set('closedTop', String(closedItemsLimit));
  // Track the active query key so SWR broadcasts can be matched
  const keyIter = iteration || '';
  _activeWiCacheKey = 'wi:' + `${keyIter}||||${area}|ct${closedItemsLimit}`;
  const taskId = addBackgroundTask('wi-load-' + Date.now(), 'Loading work items', 'list-checks');

  try {
    const res = await (window.Symphonee?.contributions?.providerFetch?.('workItem', 'listRoute', { query: params.toString() }));
    if (!res) { workItems = []; renderBacklog(); return; }
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }
    // Support both new { items, hasMoreClosed, totalClosed } and legacy array format
    if (Array.isArray(data)) {
      workItems = data;
      hasMoreClosed = false;
      totalClosedCount = 0;
      totalClosedCapped = false;
    } else {
      workItems = data.items || [];
      hasMoreClosed = data.hasMoreClosed || false;
      totalClosedCount = data.totalClosed || 0;
      totalClosedCapped = data.totalClosedCapped || false;
    }
    populateTagFilters();
    document.querySelectorAll('.multi-select').forEach(ms => updateMultiSelectLabel(ms));
    renderBoard();
    renderBacklog();
    updateActivityFeed();
    // Re-render timeline if it's open
    if (document.getElementById('activityTabBtn').style.display !== 'none') renderTimeline();
    completeBackgroundTask(taskId, true);
  } catch (e) {
    toast('Failed to load work items', 'error');
    completeBackgroundTask(taskId, false);
  }
}

function loadMoreClosed() {
  closedItemsLimit += 15;
  loadWorkItems(true);
}

function populateTagFilters() {
  const tags = new Set();
  workItems.forEach(wi => {
    if (wi.tags) wi.tags.split(';').forEach(t => { const trimmed = t.trim(); if (trimmed) tags.add(trimmed); });
  });
  const sorted = [...tags].sort((a, b) => a.localeCompare(b));
  const toggleAllHtml = sorted.length > 0
    ? `<div class="multi-select-toggle-all selected" onclick="toggleAllMultiItems(this)">Toggle All</div>`
    : '';
  const noTagHtml = `<div class="multi-select-item selected" data-value="__none__" onclick="toggleMultiItem(this)"><div class="multi-select-toggle"></div> (No Tag)</div>`;
  const html = toggleAllHtml + noTagHtml + sorted.map(tag =>
    `<div class="multi-select-item selected" data-value="${esc(tag)}" onclick="toggleMultiItem(this)"><div class="multi-select-toggle"></div> ${esc(tag)}</div>`
  ).join('');
  const backlogPanel = document.getElementById('backlogTagPanel');
  if (backlogPanel) backlogPanel.innerHTML = html;
}

function filterMyItems() {
  const user = configData.DefaultUser || '';
  if (!user) { toast('Set your display name in Settings first', 'info'); openSettings(); return; }
  filterByUser(user);
}

function filterByUser(name) {
  document.getElementById('backlogSearch').value = name;
  switchTab('backlog', true);
  filterBacklog();
}

// ── Board Rendering ─────────────────────────────────────────────────────
// ── Multi-Select Dropdown Logic ──────────────────────────────────────────
function toggleMultiSelect(el) {
  // Close others first
  document.querySelectorAll('.multi-select.open').forEach(ms => { if (ms !== el) ms.classList.remove('open'); });
  el.classList.toggle('open');
}

function toggleMultiItem(item) {
  item.classList.toggle('selected');
  const ms = item.closest('.multi-select');
  // Sync the Toggle All switch
  const toggleAll = ms.querySelector('.multi-select-toggle-all');
  if (toggleAll) {
    const allItems = ms.querySelectorAll('.multi-select-item');
    const allSelected = [...allItems].every(i => i.classList.contains('selected'));
    toggleAll.classList.toggle('selected', allSelected);
  }
  updateMultiSelectLabel(ms);
  const fn = ms.dataset.onchange;
  if (fn && window[fn]) window[fn]();
}

function toggleAllMultiItems(toggleAllEl) {
  const ms = toggleAllEl.closest('.multi-select');
  const items = ms.querySelectorAll('.multi-select-item');
  const allSelected = [...items].every(i => i.classList.contains('selected'));
  // If all on -> turn all off. If any off -> turn all on.
  items.forEach(i => i.classList.toggle('selected', !allSelected));
  toggleAllEl.classList.toggle('selected', !allSelected);
  updateMultiSelectLabel(ms);
  const fn = ms.dataset.onchange;
  if (fn && window[fn]) window[fn]();
}

function getMultiSelectValues(dataId) {
  const ms = document.querySelector(`.multi-select[data-id="${dataId}"]`);
  if (!ms) return [];
  return [...ms.querySelectorAll('.multi-select-item.selected')].map(el => el.dataset.value);
}

function updateMultiSelectLabel(ms) {
  const allItems = [...ms.querySelectorAll('.multi-select-item')];
  const selected = allItems.filter(i => i.classList.contains('selected'));
  const hidden = allItems.length - selected.length;
  const label = ms.querySelector('.multi-select-label');
  const countBadge = ms.querySelector('.multi-select-count');
  const defaultLabel = ms.querySelector('.multi-select-btn').dataset.label || label.textContent.split(' ')[0];
  label.textContent = defaultLabel;
  if (countBadge) {
    countBadge.textContent = selected.length;
    countBadge.classList.add('visible');
  }
}

// Close multi-selects when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.multi-select')) {
    document.querySelectorAll('.multi-select.open').forEach(ms => ms.classList.remove('open'));
  }
});

const HIDDEN_TYPES = ['Test Case', 'Test Suite'];

// Check if a work item has an "on hold", "hold", or "pending" tag (case-insensitive, with or without dash/space)
function isOnHold(wi) {
  if (!wi.tags) return false;
  return wi.tags.split(';').some(t => {
    const tag = t.trim().toLowerCase();
    return /^on[\s-]?hold$/.test(tag) || tag === 'hold' || tag === 'pending';
  });
}

// Track expanded parents across renders (default: collapsed; persisted in localStorage)
const _expandedParents = new Set(JSON.parse(localStorage.getItem('symphonee-expanded-parents') || '[]'));
function toggleParentCollapse(parentId, event) {
  event.stopPropagation();
  if (_expandedParents.has(parentId)) _expandedParents.delete(parentId);
  else _expandedParents.add(parentId);
  localStorage.setItem('symphonee-expanded-parents', JSON.stringify([..._expandedParents]));
  renderBoard();
}

// Highlight all family members (parent + children) on hover
function highlightFamily(parentId, on) {
  document.querySelectorAll(`[data-family="${parentId}"]`).forEach(el => {
    el.classList.toggle('family-highlight', on);
  });
}

// State colors for rollup bar
const STATE_COLORS = { New: 'var(--blue)', Active: 'var(--green)', Resolved: 'var(--mauve)', Closed: 'var(--subtext0)', Done: 'var(--subtext0)' };

function renderBoard() {
  const search = (document.getElementById('backlogSearch')?.value || '').toLowerCase();
  const typeFilters = getMultiSelectValues('backlogType');
  const stateFilters = getMultiSelectValues('backlogState');
  const tagFilters = getMultiSelectValues('backlogTag');
  let filtered = workItems;
  // Filters are ON by default; deselected items are hidden
  filtered = filtered.filter(wi => typeFilters.includes(wi.type));
  filtered = filtered.filter(wi => stateFilters.includes(wi.state));
  const totalTags = document.querySelectorAll('#backlogTagPanel .multi-select-item').length;
  if (totalTags > 0 && tagFilters.length < totalTags) {
    const showNoTag = tagFilters.includes('__none__');
    filtered = filtered.filter(wi => {
      const wiTags = wi.tags ? wi.tags.split(';').map(t => t.trim()).filter(Boolean) : [];
      if (wiTags.length === 0) return showNoTag;
      return wiTags.every(t => tagFilters.includes(t));
    });
  }
  if (search) filtered = filtered.filter(wi =>
    wi.title.toLowerCase().includes(search) || String(wi.id).includes(search) || wi.assignedTo.toLowerCase().includes(search)
  );

  // Build global parent-child index across ALL columns
  const allItemMap = new Map(filtered.map(wi => [wi.id, wi]));
  const childrenOf = new Map();   // parentId -> [all child items across all states]
  const parentOf = new Map();     // childId -> parent item

  for (const wi of filtered) {
    if (wi.parentId && allItemMap.has(wi.parentId)) {
      parentOf.set(wi.id, allItemMap.get(wi.parentId));
      if (!childrenOf.has(wi.parentId)) childrenOf.set(wi.parentId, []);
      childrenOf.get(wi.parentId).push(wi);
    }
  }

  const buckets = { New: [], Active: [], Resolved: [], Closed: [] };
  for (const wi of filtered) {
    const state = wi.state;
    if (buckets[state]) buckets[state].push(wi);
    else if (state === 'Done') buckets.Closed.push(wi);
    else buckets.New.push(wi); // fallback
  }

  // Build child rollup HTML for a parent card (only if it actually has children)
  function childRollupHtml(parentId) {
    const children = childrenOf.get(parentId);
    if (!children || children.length === 0) return ''; // no children = no bar
    const total = children.length;
    const closedCount = children.filter(c => c.state === 'Closed' || c.state === 'Done').length;
    const allDone = closedCount === total;
    const pct = (closedCount / total * 100).toFixed(1);
    return `
      <div class="child-rollup">
        <div class="child-rollup-bar"><span style="width:${pct}%;background:var(--green)"></span></div>
        <span class="child-rollup-label ${allDone ? 'child-rollup-complete' : ''}">${closedCount}/${total} closed</span>
      </div>`;
  }

  // Render a single board card
  function boardCardHtml(wi, extraClass = '', opts = {}) {
    const familyId = opts.familyId || '';
    const parentRef = opts.parentRef || null;
    const isParent = opts.isParent || false;
    const childCount = isParent ? (childrenOf.get(wi.id) || []).length : 0;
    const collapsed = !_expandedParents.has(wi.id);

    let toggleBtn = '';
    if (isParent && childCount > 0) {
      // Only show toggle if there are same-column children
      const sameColChildren = (childrenOf.get(wi.id) || []).filter(c => {
        const cs = c.state === 'Done' ? 'Closed' : c.state;
        const ws = wi.state === 'Done' ? 'Closed' : wi.state;
        return cs === ws;
      });
      if (sameColChildren.length > 0) {
        toggleBtn = `<button class="parent-toggle" onclick="toggleParentCollapse(${wi.id}, event)" title="${collapsed ? 'Expand' : 'Collapse'} children"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>`;
      }
    }

    let parentRefHtml = '';
    if (parentRef) {
      parentRefHtml = `<div class="child-parent-ref"><span onclick="event.stopPropagation();viewWorkItem(${parentRef.id})" title="${esc(parentRef.title)}">↑ #${parentRef.id} ${esc(parentRef.title.substring(0, 30))}${parentRef.title.length > 30 ? '…' : ''}</span></div>`;
    }

    return `
      <div class="board-card ${extraClass} ${parentRef ? 'has-parent' : ''} ${isOnHold(wi) ? 'on-hold' : ''}" draggable="true" data-wi-id="${wi.id}"
           ${familyId ? `data-family="${familyId}"` : ''}
           onclick="viewWorkItem(${wi.id})"
           ondragstart="onCardDragStart(event, ${wi.id})" ondragend="onCardDragEnd(event)"
           ${familyId ? `onmouseenter="highlightFamily(${familyId}, true)" onmouseleave="highlightFamily(${familyId}, false)"` : ''}>
        ${parentRefHtml}
        ${toggleBtn}
        <div class="board-card-id"><span>#${wi.id}</span>${isOnHold(wi) ? '<span class="on-hold-label">On Hold</span>' : ''}</div>
        <div class="board-card-title">${esc(wi.title)}</div>
        <div class="board-card-meta">
          <span class="board-card-type type-${wi.type.toLowerCase().replace(/\s+/g, '-')}">${wi.type}</span>
          ${wi.assignedTo ? `<span>${esc(wi.assignedTo.split(' ')[0])}</span>` : ''}
          ${wi.storyPoints ? `<span>${wi.storyPoints} pts</span>` : ''}
        </div>
        ${isParent ? childRollupHtml(wi.id) : ''}
      </div>`;
  }

  for (const [state, items] of Object.entries(buckets)) {
    const container = document.getElementById(`board${state}`);
    const count = document.getElementById(`boardCount${state}`);
    if (!container) continue;
    // For Closed column, show total count (from API) when available, not just loaded count
    if (state === 'Closed' && totalClosedCount > items.length) {
      count.textContent = totalClosedCapped ? totalClosedCount + '+' : totalClosedCount;
    } else {
      count.textContent = items.length;
    }

    // Identify same-column children (parent is in this same column)
    const colItemMap = new Map(items.map(wi => [wi.id, wi]));
    const sameColChildIds = new Set();

    for (const wi of items) {
      if (wi.parentId && colItemMap.has(wi.parentId)) {
        sameColChildIds.add(wi.id);
      }
    }

    let html = '';
    for (const wi of items) {
      if (sameColChildIds.has(wi.id)) continue; // rendered under parent group

      const sameColChildren = (childrenOf.get(wi.id) || []).filter(c => colItemMap.has(c.id));
      const hasAnyChildren = childrenOf.has(wi.id);

      if (sameColChildren.length > 0) {
        // Parent with children in same column — group them
        const collapsed = !_expandedParents.has(wi.id);
        html += `<div class="board-parent-group ${collapsed ? 'collapsed' : ''}" data-family="${wi.id}"
                      onmouseenter="highlightFamily(${wi.id}, true)" onmouseleave="highlightFamily(${wi.id}, false)">`;
        html += boardCardHtml(wi, 'parent-card', { isParent: true, familyId: wi.id });
        for (const child of sameColChildren) {
          html += boardCardHtml(child, 'child-card', { familyId: wi.id });
        }
        html += `</div>`;
      } else if (hasAnyChildren) {
        // Parent but all children are in other columns — show as standalone with rollup
        html += boardCardHtml(wi, '', { isParent: true, familyId: wi.id });
      } else if (parentOf.has(wi.id)) {
        // Child whose parent is in a different column — show parent reference
        const parent = parentOf.get(wi.id);
        html += boardCardHtml(wi, '', { parentRef: parent, familyId: parent.id });
      } else {
        // Regular standalone item
        html += boardCardHtml(wi);
      }
    }
    // Add "Show more" button to Closed column when there are more items
    // AND the user's state filter actually includes Closed/Done.
    if (state === 'Closed' && hasMoreClosed) {
      const stateFiltersNow = getMultiSelectValues('backlogState');
      if (stateFiltersNow.includes('Closed') || stateFiltersNow.includes('Done')) {
        const closedLabel = totalClosedCapped ? totalClosedCount + '+' : totalClosedCount;
        html += `<button class="show-more-closed-btn" onclick="event.stopPropagation(); loadMoreClosed();">Showing ${items.length} of ${closedLabel} - load more...</button>`;
      }
    }

    container.innerHTML = html;

    // Add drop handlers to column
    container.ondragover = (e) => { e.preventDefault(); container.classList.add('drag-over'); };
    container.ondragleave = () => container.classList.remove('drag-over');
    container.ondrop = (e) => { e.preventDefault(); container.classList.remove('drag-over'); onCardDrop(e, state); };
  }
}

// ── Backlog Rendering ───────────────────────────────────────────────────
const _collapsedBacklogParents = new Set(JSON.parse(localStorage.getItem('symphonee-collapsed-backlog') || '[]'));
function toggleBacklogParent(parentId, event) {
  event.stopPropagation();
  if (_collapsedBacklogParents.has(parentId)) _collapsedBacklogParents.delete(parentId);
  else _collapsedBacklogParents.add(parentId);
  localStorage.setItem('symphonee-collapsed-backlog', JSON.stringify([..._collapsedBacklogParents]));
  // Toggle child row visibility
  document.querySelectorAll(`tr[data-backlog-parent="${parentId}"]`).forEach(row => {
    row.classList.toggle('backlog-child-hidden', _collapsedBacklogParents.has(parentId));
  });
  // Toggle button icon
  const btn = document.querySelector(`button[data-backlog-toggle="${parentId}"]`);
  if (btn) btn.classList.toggle('collapsed', _collapsedBacklogParents.has(parentId));
}

function renderBacklog() {
  const body = document.getElementById('backlogBody');

  // Build parent-child index
  const allMap = new Map(workItems.map(wi => [wi.id, wi]));
  const childrenOf = new Map();
  const childIds = new Set();

  for (const wi of workItems) {
    if (wi.parentId && allMap.has(wi.parentId)) {
      childIds.add(wi.id);
      if (!childrenOf.has(wi.parentId)) childrenOf.set(wi.parentId, []);
      childrenOf.get(wi.parentId).push(wi);
    }
  }

  // Build rollup HTML for backlog
  function backlogRollupHtml(parentId) {
    const children = childrenOf.get(parentId);
    if (!children || children.length === 0) return '';
    const total = children.length;
    const closedCount = children.filter(c => c.state === 'Closed' || c.state === 'Done').length;
    const pct = (closedCount / total * 100).toFixed(1);
    return `<span class="backlog-child-rollup"><span class="child-rollup-bar"><span style="width:${pct}%;background:var(--green)"></span></span><span class="child-rollup-label">${closedCount}/${total}</span></span>`;
  }

  // Render rows: parents first, then their children indented
  let html = '';
  for (const wi of workItems) {
    if (childIds.has(wi.id)) continue; // rendered under parent

    const children = childrenOf.get(wi.id);
    const isParent = children && children.length > 0;
    const collapsed = _collapsedBacklogParents.has(wi.id);

    if (isParent) {
      const toggleBtn = `<button class="backlog-parent-toggle ${collapsed ? 'collapsed' : ''}" data-backlog-toggle="${wi.id}" onclick="toggleBacklogParent(${wi.id}, event)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>`;
      html += `
        <tr class="backlog-parent ${isOnHold(wi) ? 'on-hold' : ''}" onclick="viewWorkItem(${wi.id})">
          <td class="wi-id">${toggleBtn}${wi.id}</td>
          <td><span class="board-card-type type-${wi.type.toLowerCase().replace(/\s+/g, '-')}">${wi.type}</span></td>
          <td class="wi-title">${esc(wi.title)}${backlogRollupHtml(wi.id)}</td>
          <td><span class="state-badge state-${wi.state.toLowerCase()}">${wi.state}</span></td>
          <td>${esc(wi.assignedTo)}</td>
          <td class="priority-${wi.priority}">P${wi.priority}</td>
          <td>${wi.storyPoints || '-'}</td>
        </tr>`;
      for (const child of children) {
        html += `
          <tr class="backlog-child ${collapsed ? 'backlog-child-hidden' : ''} ${isOnHold(child) ? 'on-hold' : ''}" data-backlog-parent="${wi.id}" onclick="viewWorkItem(${child.id})">
            <td class="wi-id">${child.id}</td>
            <td><span class="board-card-type type-${child.type.toLowerCase().replace(/\s+/g, '-')}">${child.type}</span></td>
            <td class="wi-title">${esc(child.title)}</td>
            <td><span class="state-badge state-${child.state.toLowerCase()}">${child.state}</span></td>
            <td>${esc(child.assignedTo)}</td>
            <td class="priority-${child.priority}">P${child.priority}</td>
            <td>${child.storyPoints || '-'}</td>
          </tr>`;
      }
    } else {
      html += `
        <tr class="${isOnHold(wi) ? 'on-hold' : ''}" onclick="viewWorkItem(${wi.id})">
          <td class="wi-id">${wi.id}</td>
          <td><span class="board-card-type type-${wi.type.toLowerCase().replace(/\s+/g, '-')}">${wi.type}</span></td>
          <td class="wi-title">${esc(wi.title)}</td>
          <td><span class="state-badge state-${wi.state.toLowerCase()}">${wi.state}</span></td>
          <td>${esc(wi.assignedTo)}</td>
          <td class="priority-${wi.priority}">P${wi.priority}</td>
          <td>${wi.storyPoints || '-'}</td>
        </tr>`;
    }
  }
  // Add "Show more" row when there are more closed items AND the user's
  // state filter actually includes Closed/Done. Otherwise showing it is a
  // lie (the user can't see what they'd load) and clicking it appears to
  // inject closed items that should be filtered out.
  if (hasMoreClosed) {
    const stateFiltersNow = getMultiSelectValues('backlogState');
    const showsClosed = stateFiltersNow.includes('Closed') || stateFiltersNow.includes('Done');
    if (showsClosed) {
      const loadedClosed = workItems.filter(wi => wi.state === 'Closed' || wi.state === 'Done').length;
      const closedLabel = totalClosedCapped ? totalClosedCount + '+' : totalClosedCount;
      html += `<tr class="show-more-closed-row"><td colspan="7"><button class="show-more-closed-btn" onclick="event.stopPropagation(); loadMoreClosed();">Showing ${loadedClosed} of ${closedLabel} closed items - load more...</button></td></tr>`;
    }
  }

  body.innerHTML = html;
}

// ── Kanban Drag & Drop ──────────────────────────────────────────────────
let draggedWiId = null;

function onCardDragStart(e, wiId) {
  e.stopPropagation(); // prevent child drag from bubbling to parent group
  draggedWiId = wiId;
  e.dataTransfer.effectAllowed = 'move';
  e.target.classList.add('dragging');
}

function onCardDragEnd(e) {
  e.target.classList.remove('dragging');
}

async function onCardDrop(e, targetState) {
  if (!draggedWiId) return;
  const wiId = draggedWiId;
  draggedWiId = null;

  // Find the work item to check if state actually changed
  const wi = workItems.find(w => w.id === wiId);
  if (!wi || wi.state === targetState) return;

  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'updateStateRoute', {
      params: { id: wiId },
      init: { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: targetState }) },
    });
    if (!res) { toast('No work item provider installed', 'error'); return; }
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }
    toast(`#${wiId} moved to ${targetState}`, 'success');
    // Optimistic update + full refresh from server
    wi.state = targetState;
    renderBoard();
    renderBacklog();
    loadWorkItems(true);
  } catch (e) {
    toast('Failed to update state', 'error');
  }
}

let _backlogView = 'list'; // 'list' | 'board'

function switchBacklogView(view) {
  _backlogView = view;
  document.getElementById('btnViewList').classList.toggle('active', view === 'list');
  document.getElementById('btnViewBoard').classList.toggle('active', view === 'board');
  document.getElementById('backlogContainer').style.display = view === 'list' ? '' : 'none';
  document.getElementById('boardView').style.display = view === 'board' ? '' : 'none';
  applyBacklogFilters();
  try { lucide.createIcons(); } catch (_) {}
}

function applyBacklogFilters() {
  if (_backlogView === 'board') {
    renderBoard();
  } else {
    renderBacklog();
    filterBacklog();
  }
}

function filterBacklog() {
  const search = document.getElementById('backlogSearch').value.toLowerCase();
  const typeFilters = getMultiSelectValues('backlogType');
  const stateFilters = getMultiSelectValues('backlogState');
  const tagFilters = getMultiSelectValues('backlogTag');
  const totalTags = document.querySelectorAll('#backlogTagPanel .multi-select-item').length;
  const tagsFiltered = totalTags > 0 && tagFilters.length < totalTags;
  const hasFilters = search || tagsFiltered
    || typeFilters.length < document.querySelectorAll('[data-id="backlogType"] .multi-select-item').length
    || stateFilters.length < document.querySelectorAll('[data-id="backlogState"] .multi-select-item').length;

  function matchesFilter(wi) {
    const matchSearch = !search || wi.title.toLowerCase().includes(search) || wi.assignedTo.toLowerCase().includes(search) || String(wi.id).includes(search);
    const matchType = typeFilters.includes(wi.type);
    const matchState = stateFilters.includes(wi.state);
    let matchTag = true;
    if (tagsFiltered) {
      const showNoTag = tagFilters.includes('__none__');
      const wiTags = wi.tags ? wi.tags.split(';').map(t => t.trim()).filter(Boolean) : [];
      matchTag = wiTags.length === 0 ? showNoTag : wiTags.every(t => tagFilters.includes(t));
    }
    return matchSearch && matchType && matchState && matchTag;
  }

  // Build parent-child map for filter logic
  const allMap = new Map(workItems.map(wi => [wi.id, wi]));
  const childrenOf = new Map();
  for (const wi of workItems) {
    if (wi.parentId && allMap.has(wi.parentId)) {
      if (!childrenOf.has(wi.parentId)) childrenOf.set(wi.parentId, []);
      childrenOf.get(wi.parentId).push(wi);
    }
  }

  const rows = document.querySelectorAll('#backlogBody tr');
  let rowIdx = 0;

  for (const wi of workItems) {
    // Skip children in the flat loop — they're handled under their parent
    if (wi.parentId && allMap.has(wi.parentId)) continue;

    const children = childrenOf.get(wi.id) || [];
    const isParent = children.length > 0;

    if (isParent) {
      const parentMatch = matchesFilter(wi);
      const anyChildMatch = children.some(c => matchesFilter(c));
      const showParent = !hasFilters || parentMatch || anyChildMatch;

      if (rows[rowIdx]) rows[rowIdx].style.display = showParent ? '' : 'none';
      rowIdx++;

      for (const child of children) {
        const childMatch = !hasFilters || matchesFilter(child);
        const collapsed = _collapsedBacklogParents.has(wi.id);
        if (rows[rowIdx]) rows[rowIdx].style.display = (showParent && childMatch && !collapsed) ? '' : 'none';
        rowIdx++;
      }
    } else {
      if (rows[rowIdx]) rows[rowIdx].style.display = matchesFilter(wi) ? '' : 'none';
      rowIdx++;
    }
  }
}

// ── Work Item Detail ────────────────────────────────────────────────────
async function viewWorkItem(id) {
  openPopupTab('workitemTabBtn');
  const container = document.getElementById('wiDetail');
  container.innerHTML = '<div class="empty-state"><div class="spinner"></div><div class="empty-state-text">Loading...</div></div>';

  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'getRoute', { params: { id } });
    if (!res) { container.innerHTML = '<div class="empty-state"><div class="empty-state-text">No work item provider installed</div></div>'; return; }
    const wi = await res.json();
    if (wi.error) { container.innerHTML = `<div class="empty-state"><div class="empty-state-text">${esc(wi.error)}</div></div>`; return; }
    currentWiDetail = wi;

    container.innerHTML = `
      <div class="wi-detail-header">
        <div>
          <div class="wi-detail-id"><span class="board-card-type type-${wi.type.toLowerCase().replace(/\s+/g, '-')}">${wi.type}</span> #${wi.id}</div>
          <div class="wi-detail-title">${esc(wi.title)}</div>
        </div>
        <div class="wi-detail-actions">
          ${wi.webUrl ? (() => {
            const prov = window.Symphonee?.contributions?.activeWorkItemProvider?.();
            const label = (prov && prov.label) ? ('Open in ' + prov.label) : 'Open in provider';
            return `<button class="btn btn-sm" onclick="window.open('${wi.webUrl}','_blank')"><i data-lucide="external-link"></i> ${esc(label)}</button>`;
          })() : ''}
          <button class="btn btn-sm" onclick="closeWorkItemView()" style="color:var(--subtext0);"><i data-lucide="x"></i> Close</button>
        </div>
      </div>
      <div class="wi-detail-fields">
        <div class="wi-field"><div class="wi-field-label">State</div><div class="wi-field-value"><span class="state-badge state-${wi.state.toLowerCase()}">${wi.state}</span></div></div>
        <div class="wi-field"><div class="wi-field-label">Assigned To</div><div class="wi-field-value">${esc(wi.assignedTo) || 'Unassigned'}</div></div>
        <div class="wi-field"><div class="wi-field-label">Priority</div><div class="wi-field-value priority-${wi.priority}">P${wi.priority}</div></div>
        <div class="wi-field"><div class="wi-field-label">Story Points</div><div class="wi-field-value">${wi.storyPoints || wi.effort || '-'}</div></div>
        <div class="wi-field"><div class="wi-field-label">Area Path</div><div class="wi-field-value">${esc(wi.areaPath)}</div></div>
        <div class="wi-field"><div class="wi-field-label">Iteration</div><div class="wi-field-value">${esc(wi.iterationPath)}</div></div>
        <div class="wi-field"><div class="wi-field-label">Created</div><div class="wi-field-value">${formatDate(wi.createdDate)}</div></div>
        <div class="wi-field"><div class="wi-field-label">Changed</div><div class="wi-field-value">${formatDate(wi.changedDate)}</div></div>
      </div>
      ${wi.tags ? `<div class="wi-tags">${wi.tags.split(';').map(t => t.trim()).filter(Boolean).map(t => `<span class="wi-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${wi.description ? `<div class="wi-detail-section"><div class="wi-detail-section-title">Description</div><div class="wi-detail-html">${wi.description}</div></div>` : ''}
      ${wi.acceptanceCriteria ? `<div class="wi-detail-section"><div class="wi-detail-section-title">Acceptance Criteria</div><div class="wi-detail-html">${wi.acceptanceCriteria}</div></div>` : ''}
      ${wi.reproSteps ? `<div class="wi-detail-section"><div class="wi-detail-section-title">Repro Steps</div><div class="wi-detail-html">${wi.reproSteps}</div></div>` : ''}
      ${wi.linkedItems.length > 0 ? `
        <div class="wi-detail-section">
          <div class="wi-detail-section-title">Linked Items</div>
          ${wi.linkedItems.filter(l => l.id).map(l => `
            <div class="wi-linked" onclick="viewWorkItem(${l.id})">
              <span class="wi-linked-id">#${l.id}</span>
              <span class="wi-linked-rel">${formatRelationType(l.rel)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="wi-detail-section">
        <div class="wi-detail-section-title">Discussion</div>
        <div id="wiCommentsList">
          ${wi.comments.length > 0 ? wi.comments.map(c => `
            <div class="wi-comment">
              <span class="wi-comment-author">${esc(c.author)}</span>
              <span class="wi-comment-date">${formatDate(c.date)}</span>
              <div class="wi-comment-body">${c.text}</div>
            </div>
          `).join('') : '<div style="font-size:12px;color:var(--subtext0);padding:8px 0;">No comments yet.</div>'}
        </div>
        <div style="margin-top:10px;display:flex;gap:6px;align-items:center;">
          <input class="pr-comment-input" id="wiCommentInput" type="text" placeholder="Leave a comment..." style="flex:1;">
          <button class="pr-expand-btn" onclick="openWICommentModal(${wi.id})" title="Expand"><i data-lucide="expand" style="width:14px;height:14px;"></i></button>
          <button class="pr-btn pr-btn-comment" onclick="addWIComment(${wi.id})">Comment</button>
        </div>
      </div>
      <div style="margin-top:20px;padding:14px;background:var(--surface0);border-radius:var(--radius-lg);border:1px solid var(--surface1);">
        ${configData.Repos && _repoNamesForSpace(configData.Repos, window._spacesCache || {}, activeSpace).length > 0 ? `
          <div style="display:flex;align-items:center;gap:10px;">
            <select id="startWorkRepo" onchange="selectRepo(this.value)" style="padding:7px 10px;background:var(--base);border:1px solid var(--surface1);border-radius:var(--radius);color:var(--text);font:12px var(--font-ui);outline:none;flex:1;">
              ${_repoNamesForSpace(configData.Repos, window._spacesCache || {}, activeSpace).map(r => `<option value="${esc(r)}"${r === activeRepo ? ' selected' : ''}>${esc(r)}</option>`).join('')}
            </select>
            <button class="btn btn-primary" onclick="startWorking(${wi.id})" style="flex-shrink:0;width:auto;padding:7px 16px;"><i data-lucide="play"></i> Start Working</button>
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:12px;color:var(--subtext0);flex:1;">No repositories configured yet.</span>
            <button class="btn btn-sm" onclick="openSettings()" style="width:auto;flex-shrink:0;"><i data-lucide="settings"></i> Add in Settings</button>
          </div>
        `}
      </div>
    `;
    lucide.createIcons();
    // Attach @mention autocomplete to inline comment input
    attachMention(document.getElementById('wiCommentInput'));
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load work item</div></div>`;
  }
}

function closeWorkItemView() {
  closeWorkItemTab();
}

function closeWorkItemTab() {
  currentWiDetail = null;
  closePopupTab('workitemTabBtn');
}

// ── @mention autocomplete ────────────────────────────────────────────
let _mentionCache = null;
let _mentionActiveIdx = -1;
let _mentionTarget = null; // the input/textarea being typed in
let _mentionStart = -1;    // caret position of the '@'

async function getMentionMembers() {
  if (_mentionCache) return _mentionCache;
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'teamMembersRoute', {});
    if (!res) { _mentionCache = []; return _mentionCache; }
    const data = await res.json();
    if (!data.error) _mentionCache = data;
    return _mentionCache || [];
  } catch (_) { return []; }
}

function mentionSearch(query, members) {
  const q = query.toLowerCase();
  return members.filter(m =>
    m.displayName.toLowerCase().includes(q) || m.uniqueName.toLowerCase().includes(q)
  ).slice(0, 8);
}

function renderMentionDropdown(matches) {
  const dd = document.getElementById('mentionDropdown');
  if (!matches.length) { dd.classList.remove('open'); return; }
  _mentionActiveIdx = 0;
  dd.innerHTML = matches.map((m, i) => `
    <div class="mention-item${i === 0 ? ' active' : ''}" data-idx="${i}" data-name="${esc(m.displayName)}">
      <div class="mention-avatar">${(m.displayName || '?')[0].toUpperCase()}</div>
      <div>
        <div class="mention-name">${esc(m.displayName)}</div>
        <div class="mention-email">${esc(m.uniqueName)}</div>
      </div>
    </div>
  `).join('');
  dd.classList.add('open');

  // Position near the caret
  positionMentionDropdown();

  // Click handler
  dd.querySelectorAll('.mention-item').forEach(item => {
    item.onmousedown = (e) => {
      e.preventDefault();
      acceptMention(item.dataset.name);
    };
  });
}

function positionMentionDropdown() {
  const dd = document.getElementById('mentionDropdown');
  if (!_mentionTarget) return;
  const rect = _mentionTarget.getBoundingClientRect();
  // Place below the input, aligned left
  dd.style.left = rect.left + 'px';
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.minWidth = Math.min(rect.width, 280) + 'px';
}

function acceptMention(name) {
  if (!_mentionTarget) return;
  const el = _mentionTarget;
  const val = el.value;
  const before = val.slice(0, _mentionStart);
  const after = val.slice(el.selectionStart || _mentionStart);
  el.value = before + '@' + name + ' ' + after;
  // Move caret after the inserted name
  const newPos = _mentionStart + name.length + 2; // @name + space
  el.setSelectionRange(newPos, newPos);
  el.focus();
  closeMentionDropdown();
}

function closeMentionDropdown() {
  const dd = document.getElementById('mentionDropdown');
  dd.classList.remove('open');
  _mentionActiveIdx = -1;
  _mentionStart = -1;
}

async function handleMentionInput(e) {
  const el = e.target;
  _mentionTarget = el;
  const val = el.value;
  const caret = el.selectionStart || 0;

  // Find the '@' before the caret with no spaces between @ and caret
  const textBefore = val.slice(0, caret);
  const atIdx = textBefore.lastIndexOf('@');
  if (atIdx < 0) { closeMentionDropdown(); return; }

  // The character before @ must be start-of-string, space, or newline
  if (atIdx > 0 && !/[\s\n]/.test(val[atIdx - 1])) { closeMentionDropdown(); return; }

  const query = textBefore.slice(atIdx + 1);
  // If query has a space, mention is done
  if (/\s/.test(query)) { closeMentionDropdown(); return; }

  _mentionStart = atIdx;
  const members = await getMentionMembers();
  const matches = query.length === 0 ? members.slice(0, 8) : mentionSearch(query, members);
  renderMentionDropdown(matches);
}

function handleMentionKeydown(e) {
  const dd = document.getElementById('mentionDropdown');
  if (!dd.classList.contains('open')) return;
  const items = dd.querySelectorAll('.mention-item');
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[_mentionActiveIdx]?.classList.remove('active');
    _mentionActiveIdx = (_mentionActiveIdx + 1) % items.length;
    items[_mentionActiveIdx]?.classList.add('active');
    items[_mentionActiveIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[_mentionActiveIdx]?.classList.remove('active');
    _mentionActiveIdx = (_mentionActiveIdx - 1 + items.length) % items.length;
    items[_mentionActiveIdx]?.classList.add('active');
    items[_mentionActiveIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (_mentionActiveIdx >= 0 && items[_mentionActiveIdx]) {
      e.preventDefault();
      acceptMention(items[_mentionActiveIdx].dataset.name);
    }
  } else if (e.key === 'Escape') {
    closeMentionDropdown();
  }
}

// Attach to an input/textarea element
function attachMention(el) {
  if (!el || el._mentionAttached) return;
  el._mentionAttached = true;
  el.addEventListener('input', handleMentionInput);
  el.addEventListener('keydown', handleMentionKeydown);
  el.addEventListener('blur', () => setTimeout(closeMentionDropdown, 200));
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.mention-dropdown') && !e.target.closest('#wiCommentInput') && !e.target.closest('#wiCommentModalInput')) {
    closeMentionDropdown();
  }
});

let _wiCommentTargetId = null;

function openWICommentModal(wiId) {
  _wiCommentTargetId = wiId;
  const inline = document.getElementById('wiCommentInput');
  const modal = document.getElementById('wiCommentModal');
  const textarea = document.getElementById('wiCommentModalInput');
  textarea.value = inline ? inline.value : '';
  modal.classList.add('open');
  const submitBtn = document.getElementById('wiCommentModalSubmit');
  submitBtn.onclick = () => submitWICommentModal();
  attachMention(textarea);
  setTimeout(() => textarea.focus(), 100);
}

function closeWICommentModal() {
  document.getElementById('wiCommentModal').classList.remove('open');
}

async function submitWICommentModal() {
  const textarea = document.getElementById('wiCommentModalInput');
  const text = textarea.value.trim();
  if (!text || !_wiCommentTargetId) return;
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'commentRoute', {
      params: { id: _wiCommentTargetId },
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) },
    });
    if (!res) { toast('No work item provider installed', 'error'); return; }
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }
    textarea.value = '';
    const inline = document.getElementById('wiCommentInput');
    if (inline) inline.value = '';
    closeWICommentModal();
    toast('Comment added', 'success');
    viewWorkItem(_wiCommentTargetId);
  } catch (e) { toast('Failed to add comment', 'error'); }
}

async function addWIComment(wiId) {
  const input = document.getElementById('wiCommentInput');
  const text = input.value.trim();
  if (!text) return;
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'commentRoute', {
      params: { id: wiId },
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) },
    });
    if (!res) { toast('No work item provider installed', 'error'); return; }
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }
    input.value = '';
    toast('Comment added', 'success');
    viewWorkItem(wiId);
  } catch (e) { toast('Failed to add comment', 'error'); }
}

// ── Start Working ───────────────────────────────────────────────────────
async function startWorking(wiId) {
  const repoSelect = document.getElementById('startWorkRepo');
  if (!repoSelect) return;
  const repoName = repoSelect.value;

  // Sync the sidebar repo selection to match
  if (repoName && repoName !== activeRepo) {
    selectRepo(repoName);
  }

  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'startWorkingRoute', {
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workItemId: wiId, repoName }) },
    });
    if (!res) { toast('No work item provider installed', 'error'); return; }
    const data = await res.json();
    if (data.error) { toast(data.error, 'error'); return; }

    toast(`Branch: ${data.branchName}`, 'success');
    switchTab('terminal');

    // Resolve the active workItemProvider's detail route so the AI prompt
    // stays provider-agnostic. Falls back to a bootstrap lookup instruction
    // when no provider is resolvable (should not happen since startWorking
    // already required a provider to succeed).
    const provider = window.Symphonee?.contributions?.activeWorkItemProvider?.();
    const getRouteUrl = provider
      ? (window.Symphonee.contributions.resolve(provider, 'getRoute') || '').replace(':id', String(wiId))
      : '';
    const fetchInstruction = getRouteUrl
      ? `1. Fetch the full work item details from the active work-item provider at http://127.0.0.1:3800${getRouteUrl}`
      : `1. Call http://127.0.0.1:3800/api/bootstrap, find the workItemProvider contribution, resolve its getRoute, and fetch work item #${wiId}`;

    const ctx = [
      `I am starting work on work item #${wiId}.`,
      `Branch "${data.branchName}" has been created and checked out in "${data.repoPath}".`,
      ``,
      `Do the following:`,
      fetchInstruction,
      `   This returns: title, type, state, priority, tags, description, acceptance criteria,`,
      `   repro steps, story points, effort, linked items, attachments, and comments.`,
      `2. For any linked items (parent or children), fetch their details too so you understand the full scope.`,
      `3. If there are attachments (especially images), download and view them for visual context.`,
      `4. Analyze everything and suggest an approach for implementing this work item.`,
    ].join('\n');

    const sendCtx = () => setTimeout(() => sendCommand(ctx), 2000);
    if (!aiLaunched) {
      setTimeout(() => { launchAi(); sendCtx(); }, 500);
    } else {
      sendCtx();
    }
  } catch (e) {
    toast('Failed to start working', 'error');
  }
}

// ── Sprint Card ─────────────────────────────────────────────────────────
function updateSprintCard(iteration) {
  if (!iteration) return;
  const info = document.getElementById('sprintInfo');
  const start = new Date(iteration.startDate);
  const finish = new Date(iteration.finishDate);
  const now = new Date();
  const total = (finish - start) / 86400000;
  const elapsed = (now - start) / 86400000;
  const remaining = Math.max(0, Math.ceil((finish - now) / 86400000));
  const pct = Math.min(100, Math.round((elapsed / total) * 100));

  info.innerHTML = `
    <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px;">${esc(iteration.name)}</div>
    <div class="stat-row"><span class="stat-label">Start</span><span class="stat-value">${formatDate(iteration.startDate)}</span></div>
    <div class="stat-row"><span class="stat-label">End</span><span class="stat-value">${formatDate(iteration.finishDate)}</span></div>
    <div class="stat-row"><span class="stat-label">Remaining</span><span class="stat-value">${remaining} days</span></div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div style="font-size:10px;color:var(--subtext0);text-align:right;">${pct}% elapsed</div>
  `;
}

// ── Burndown ────────────────────────────────────────────────────────────
async function loadBurndown(iterationPath) {
  const info = document.getElementById('burndownInfo');
  info.innerHTML = '<div class="spinner" style="margin:10px auto;"></div>';
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'burndownRoute', { query: { iteration: iterationPath } });
    if (!res) { info.textContent = 'No work item provider'; return; }
    const data = await res.json();
    if (data.error) { info.textContent = data.error; return; }

    const pct = data.totalPoints > 0 ? Math.round((data.completedPoints / data.totalPoints) * 100) : 0;
    info.innerHTML = `
      <div class="stat-row"><span class="stat-label">Total Points</span><span class="stat-value">${data.totalPoints}</span></div>
      <div class="stat-row"><span class="stat-label">Completed</span><span class="stat-value" style="color:var(--green)">${data.completedPoints}</span></div>
      <div class="stat-row"><span class="stat-label">Remaining</span><span class="stat-value" style="color:var(--yellow)">${data.remainingPoints}</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="stat-row"><span class="stat-label">Items</span><span class="stat-value">${data.completedItems}/${data.totalItems}</span></div>
    `;
  } catch (e) {
    info.textContent = 'Failed to load burndown';
  }
}

// ── Velocity ────────────────────────────────────────────────────────────
async function loadVelocity() {
  const info = document.getElementById('velocityInfo');
  info.innerHTML = '<div class="spinner" style="margin:10px auto;"></div>';
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'velocityRoute', {});
    if (!res) { info.textContent = 'No work item provider'; return; }
    const data = await res.json();
    if (data.error) { info.textContent = data.error; return; }

    info.innerHTML = `<div class="stat-row"><span class="stat-label">Average Velocity</span><span class="stat-value">${data.averageVelocity} pts/iteration</span></div>`;
    drawVelocityChart(data.velocity, data.averageVelocity);
  } catch (e) {
    info.textContent = 'Failed to load velocity';
  }
}

function drawVelocityChart(velocity, avg) {
  const canvas = document.getElementById('velocityChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  if (velocity.length === 0) return;

  const maxPts = Math.max(...velocity.map(v => v.completedPoints), avg, 1);
  const barW = Math.min(30, (chartW / velocity.length) * 0.6);
  const gap = (chartW - barW * velocity.length) / (velocity.length + 1);

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const subtextColor = getComputedStyle(document.documentElement).getPropertyValue('--subtext0').trim();
  const surfaceColor = getComputedStyle(document.documentElement).getPropertyValue('--surface0').trim();

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (chartH / 4) * i;
    ctx.strokeStyle = surfaceColor;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = subtextColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxPts * (1 - i / 4)), pad.left - 6, y + 3);
  }

  // Bars
  velocity.forEach((v, i) => {
    const x = pad.left + gap + i * (barW + gap);
    const barH = (v.completedPoints / maxPts) * chartH;
    const y = pad.top + chartH - barH;

    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
    ctx.fill();

    // Label
    ctx.fillStyle = subtextColor;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    const label = v.iteration.length > 8 ? v.iteration.slice(0, 8) + '..' : v.iteration;
    ctx.fillText(label, x + barW / 2, h - pad.bottom + 14);

    // Value on top
    ctx.fillStyle = accentColor;
    ctx.font = '10px sans-serif';
    ctx.fillText(v.completedPoints, x + barW / 2, y - 4);
  });

  // Average line
  const avgY = pad.top + chartH - (avg / maxPts) * chartH;
  ctx.strokeStyle = subtextColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(pad.left, avgY); ctx.lineTo(w - pad.right, avgY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = subtextColor;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`avg: ${avg}`, w - pad.right + 4, avgY + 3);
}

// ── Team ────────────────────────────────────────────────────────────────
async function loadTeams() {
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'teamsRoute', {});
    if (!res) return;
    const teams = await res.json();
    if (teams.error) return;

    const select = document.getElementById('boardTeamSelect');
    select.innerHTML = '';
    const currentTeam = configData.DefaultTeam || '';
    for (const t of teams) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      if (t.name === currentTeam) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (_) {}
}

async function switchTeam(teamName) {
  if (!teamName) return;
  // Save to config
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ DefaultTeam: teamName }),
  });
  configData.DefaultTeam = teamName;
  // Reset child filters - both Area and Iteration depend on the selected team
  document.getElementById('areaSelect').value = '';
  document.getElementById('sprintSelect').value = '';
  closedItemsLimit = 10;
  // Reload everything for the new team
  loadAreas();
  loadIterations();
  loadWorkItems(true);
  loadTeamMembers();
  pushUiContext();
}

// ── Area Paths ──────────────────────────────────────────────────────────
async function loadAreas() {
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'areasRoute', {});
    if (!res) return;
    const areas = await res.json();
    if (areas.error) return;

    const select = document.getElementById('areaSelect');
    const prev = select.value;
    select.innerHTML = '<option value="">Team Default</option>';
    for (const area of areas) {
      const opt = document.createElement('option');
      opt.value = area;
      // Show indented name: strip project prefix for readability
      const parts = area.split('\\');
      const indent = parts.length > 1 ? '\u00A0\u00A0'.repeat(parts.length - 1) : '';
      opt.textContent = indent + parts[parts.length - 1];
      opt.title = area;
      if (area === prev) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (_) {}
}

function onAreaChange() {
  closedItemsLimit = 10;
  loadWorkItems(true);
  pushUiContext();
}

async function loadTeamMembers() {
  const container = document.getElementById('teamList');
  container.innerHTML = '<div class="spinner" style="margin:10px auto;"></div>';
  try {
    const pf = window.Symphonee?.contributions?.providerFetch;
    const res = pf && await pf('workItem', 'teamMembersRoute', {});
    if (!res) { container.textContent = 'No work item provider'; return; }
    const data = await res.json();
    if (data.error) { container.textContent = data.error; return; }

    container.innerHTML = data.map(m => `
      <div class="team-member" onclick="filterByUser('${esc(m.displayName)}')" style="cursor:pointer;" title="View ${esc(m.displayName)}'s items">
        <div class="team-avatar">${(m.displayName || '?')[0]}</div>
        <div>
          <div class="team-name">${esc(m.displayName)}</div>
          <div class="team-email">${esc(m.uniqueName)}</div>
        </div>
      </div>
    `).join('');

    // Populate the create modal assign dropdown
    const assignSelect = document.getElementById('createAssign');
    assignSelect.innerHTML = '<option value="">Unassigned</option>';
    for (const m of data) {
      const opt = document.createElement('option');
      opt.value = m.displayName;
      opt.textContent = m.displayName;
      assignSelect.appendChild(opt);
    }
  } catch (e) {
    container.textContent = 'Failed to load team';
  }
}

function filterTeamMembers() {
  const q = document.getElementById('teamSearch').value.toLowerCase();
  document.querySelectorAll('#teamList .team-member').forEach(el => {
    const name = el.querySelector('.team-name')?.textContent.toLowerCase() || '';
    const email = el.querySelector('.team-email')?.textContent.toLowerCase() || '';
    el.style.display = (name.includes(q) || email.includes(q)) ? '' : 'none';
  });
}

// ── Activity Feed ───────────────────────────────────────────────────────
function updateActivityFeed() {
  const container = document.getElementById('activityFeed');
  const recent = [...workItems]
    .sort((a, b) => new Date(b.changedDate) - new Date(a.changedDate))
    .slice(0, 25);

  if (recent.length === 0) {
    container.innerHTML = '<div style="color:var(--subtext0);font-size:12px;">No recent activity</div>';
    return;
  }

  // Determine activity type based on state and timing
  function activityLabel(wi) {
    const state = wi.state;
    const changed = new Date(wi.changedDate);
    const created = wi.createdDate ? new Date(wi.createdDate) : null;
    const hoursSince = (Date.now() - changed) / 3600000;

    if (state === 'Closed' || state === 'Done') return { text: 'Closed', color: 'var(--subtext0)', icon: 'check-circle' };
    if (state === 'Resolved') return { text: 'Resolved', color: 'var(--mauve)', icon: 'check' };
    if (state === 'Active') return { text: 'In Progress', color: 'var(--green)', icon: 'play' };
    if (state === 'New' && hoursSince < 48) {
      // Only say "Created" if changedDate is within 2 minutes of createdDate (truly new)
      const isRealCreation = created && Math.abs(changed - created) < 120000;
      if (isRealCreation) return { text: 'Created', color: 'var(--blue)', icon: 'plus-circle' };
      return { text: 'Updated', color: 'var(--sapphire)', icon: 'edit' };
    }
    return { text: state, color: 'var(--subtext0)', icon: 'circle' };
  }

  container.innerHTML = recent.map(wi => {
    const act = activityLabel(wi);
    return `
    <div class="activity-item" onclick="viewWorkItem(${wi.id})" style="cursor:pointer;">
      <div class="activity-dot" style="background:${act.color}"></div>
      <div style="flex:1;min-width:0;">
        <div class="activity-text">
          <span style="font-size:10px;font-weight:600;color:${act.color}">${act.text}</span>
          <strong>#${wi.id}</strong> ${esc(wi.title)}
        </div>
        <div class="activity-time">
          ${wi.assignedTo ? `${esc(wi.assignedTo.split(' ')[0])} · ` : ''}${formatDate(wi.changedDate)}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Slash-menu (ComposeSlashMenu) ───────────────────────────────────────
// Typing '/' at the start of a token opens a menu of composer actions:
// send-to-ai, attach-file, navigate-to-view, etc. Each action is a function
// that receives (input, match). Registered commands:
const SLASH_COMMANDS = [
  {
    slug: 'ask',
    label: 'Ask AI',
    desc: 'Send the rest of the line to the active AI',
    hint: 'Send',
    run: (input) => {
      const line = (input.value || '').replace(/^\/ask\s*/i, '').trim();
      if (!line) return;
      input.value = '';
      if (typeof askAIFromPalette === 'function') askAIFromPalette(line, { from: 'quick-ask' });
    },
  },
  {
    slug: 'goto',
    label: 'Go to view',
    desc: 'Switch tabs: /goto terminal, /goto backlog, /goto notes',
    hint: 'Navigate',
    run: (input) => {
      const view = (input.value || '').replace(/^\/goto\s*/i, '').trim().toLowerCase();
      if (!view) return;
      input.value = '';
      if (typeof switchTab === 'function') switchTab(view);
    },
  },
  {
    slug: 'note',
    label: 'Create note',
    desc: 'Open Notes tab with a new note',
    hint: 'Note',
    run: (input) => {
      input.value = '';
      if (typeof switchTab === 'function') switchTab('notes');
    },
  },
  {
    slug: 'find',
    label: 'Find',
    desc: 'Enter search-mode: press Enter, then type what to find',
    hint: 'Search',
    run: (input) => {
      // Two-step flow: activate sticky find-mode and wait for the query.
      if (typeof _cmdPaletteEnterMode === 'function') _cmdPaletteEnterMode('find');
      else { input.value = 'find '; input.dispatchEvent(new Event('input')); }
    },
  },
];

function attachSlashMenu(inputEl) {
  if (!inputEl || inputEl._slashWired) return;
  inputEl._slashWired = true;
  const menu = document.getElementById('mentionMenu');
  let activeIdx = 0;
  let items = [];
  let anchorStart = -1;
  const close = () => {
    if (!menu.classList.contains('open')) return;
    if (menu.dataset.mode !== 'slash') return;
    menu.classList.remove('open');
    menu.removeAttribute('data-mode');
    anchorStart = -1;
    items = [];
  };
  const render = () => {
    menu.dataset.mode = 'slash';
    menu.innerHTML = items.map((it, i) =>
      '<div class="mention-item ' + (i === activeIdx ? 'active' : '') + '" data-idx="' + i + '">' +
        '<span class="mention-ico"><i data-lucide="slash"></i></span>' +
        '<span class="mention-label">/' + it.slug + '</span>' +
        '<span class="mention-desc">' + it.hint + '</span>' +
      '</div>'
    ).join('') || '<div class="mention-item" style="color:var(--overlay1);cursor:default;">no matches</div>';
    try { lucide.createIcons({ nodes: [menu] }); } catch (_) {}
    menu.querySelectorAll('.mention-item').forEach(row => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const i = parseInt(row.dataset.idx || '-1', 10);
        if (i >= 0) pick(i);
      });
    });
  };
  const pick = (i) => {
    const it = items[i];
    if (!it) return close();
    // Replace '/query' with '/slug ' so the user can continue typing args.
    const v = inputEl.value || '';
    const caret = inputEl.selectionStart || v.length;
    const prefix = v.slice(0, anchorStart);
    const suffix = v.slice(caret);
    const insert = '/' + it.slug + ' ';
    inputEl.value = prefix + insert + suffix;
    const newPos = (prefix + insert).length;
    inputEl.setSelectionRange(newPos, newPos);
    close();
    inputEl.focus();
  };
  const refresh = () => {
    const v = inputEl.value || '';
    const caret = inputEl.selectionStart || v.length;
    const slice = v.slice(0, caret);
    // Only trigger at start-of-input (slash menu is line-start only).
    const m = /^\/(\w*)$/.exec(slice);
    if (!m) return close();
    const q = m[1].toLowerCase();
    items = SLASH_COMMANDS.filter(c => !q || c.slug.startsWith(q)).slice(0, 10);
    anchorStart = 0;
    activeIdx = 0;
    const rect = inputEl.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.top - 4) + 'px';
    menu.style.transform = 'translateY(-100%)';
    menu.classList.add('open');
    render();
  };
  inputEl.addEventListener('input', refresh);
  inputEl.addEventListener('keydown', (e) => {
    if (menu.classList.contains('open') && menu.dataset.mode === 'slash') {
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % Math.max(1, items.length); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + items.length) % Math.max(1, items.length); render(); }
      else if (e.key === 'Tab') { if (items.length) { e.preventDefault(); e.stopPropagation(); pick(activeIdx); } }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    // Enter executes the matched slash command against the current input.
    if (e.key === 'Enter' && !e.shiftKey) {
      const v = (inputEl.value || '').trimStart();
      const m = /^\/(\w+)(?:\s|$)/.exec(v);
      if (m) {
        const cmd = SLASH_COMMANDS.find(c => c.slug === m[1].toLowerCase());
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          close();
          try { cmd.run(inputEl); } catch (err) { console.warn('[slash]', err); }
        }
      }
    }
  }, true);
  inputEl.addEventListener('blur', () => setTimeout(close, 120));
}
document.addEventListener('DOMContentLoaded', () => {
  attachSlashMenu(document.getElementById('cmdPaletteInput'));
});

// ── @mention autocomplete ───────────────────────────────────────────────
// Attach to any textarea/input to pop a menu when the user types '@'. The
// menu lists skills and repos; selecting inserts '@skill-slug ' into the
// composer so the agent can read it and fetch the skill body.
let _mentionSkillsCache = null;
async function _mentionSkills() {
  if (_mentionSkillsCache) return _mentionSkillsCache;
  try {
    const r = await fetch('/api/skills');
    _mentionSkillsCache = r.ok ? await r.json() : [];
  } catch (_) { _mentionSkillsCache = []; }
  return _mentionSkillsCache;
}
function _mentionItems(query, repos) {
  const q = (query || '').toLowerCase();
  const out = [];
  ( _mentionSkillsCache || []).forEach(s => {
    if (!q || s.slug.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)) {
      out.push({ type: 'skill', slug: s.slug, label: s.slug, desc: 'SKILL', hint: s.description || '' });
    }
  });
  _repoNamesForSpace(repos || {}, window._spacesCache || {}, activeSpace).forEach(name => {
    if (!q || name.toLowerCase().includes(q)) {
      out.push({ type: 'repo', slug: name, label: name, desc: 'REPO' });
    }
  });
  return out.slice(0, 10);
}
function attachMentions(inputEl) {
  if (!inputEl || inputEl._mentionsWired) return;
  inputEl._mentionsWired = true;
  const menu = document.getElementById('mentionMenu');
  let activeIdx = 0;
  let items = [];
  let anchorStart = -1;
  let reposCache = null;

  const close = () => {
    menu.classList.remove('open');
    menu.classList.remove('in-palette');
    const palette = inputEl.id === 'cmdPaletteInput' ? inputEl.closest('.cmd-palette') : null;
    if (palette) palette.classList.remove('mention-open');
    anchorStart = -1;
    items = [];
  };
  const getTokenAt = () => {
    const v = inputEl.value || '';
    const caret = inputEl.selectionStart || v.length;
    const slice = v.slice(0, caret);
    const m = /@([A-Za-z0-9_-]*)$/.exec(slice);
    if (!m) return null;
    return { start: caret - m[0].length, query: m[1] };
  };
  const positionMenu = () => {
    // Special-case the command palette: anchor to the palette frame so the
    // menu feels like a native part of the palette (same width, flush with
    // the input) instead of a detached panel floating above it.
    const palette = inputEl.id === 'cmdPaletteInput' ? inputEl.closest('.cmd-palette') : null;
    if (palette) {
      const pr = palette.getBoundingClientRect();
      const ir = inputEl.getBoundingClientRect();
      menu.style.left = pr.left + 'px';
      menu.style.top = (ir.bottom) + 'px';
      menu.style.width = pr.width + 'px';
      menu.style.minWidth = '';
      menu.style.maxWidth = '';
      menu.style.transform = '';
      menu.classList.add('in-palette');
      return;
    }
    const rect = inputEl.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.top - 4) + 'px';
    menu.style.width = '';
    menu.style.transform = 'translateY(-100%)';
    menu.classList.remove('in-palette');
  };
  const render = () => {
    menu.innerHTML = items.map((it, i) =>
      '<div class="mention-item ' + (i === activeIdx ? 'active' : '') + '" data-idx="' + i + '">' +
        '<span class="mention-ico"><i data-lucide="' + (it.type === 'skill' ? 'sparkles' : 'git-branch') + '"></i></span>' +
        '<span class="mention-label">' + it.label + '</span>' +
        '<span class="mention-desc">' + it.desc + '</span>' +
      '</div>'
    ).join('') || '<div class="mention-item" style="color:var(--overlay1);cursor:default;">no matches</div>';
    try { lucide.createIcons({ nodes: [menu] }); } catch (_) {}
    menu.querySelectorAll('.mention-item').forEach(row => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const i = parseInt(row.dataset.idx || '-1', 10);
        if (i >= 0) pick(i);
      });
    });
  };
  const pick = (i) => {
    const it = items[i];
    if (!it || anchorStart < 0) return close();
    const v = inputEl.value || '';
    const caret = inputEl.selectionStart || v.length;
    const prefix = v.slice(0, anchorStart);
    const suffix = v.slice(caret);
    const insert = '@' + it.slug + ' ';
    inputEl.value = prefix + insert + suffix;
    const newPos = (prefix + insert).length;
    inputEl.setSelectionRange(newPos, newPos);
    close();
    inputEl.dispatchEvent(new Event('input'));
    inputEl.focus();
  };
  const refresh = async () => {
    const tok = getTokenAt();
    if (!tok) return close();
    if (!reposCache) {
      try { reposCache = await fetch('/api/repos').then(r => r.ok ? r.json() : {}); }
      catch (_) { reposCache = {}; }
    }
    await _mentionSkills();
    anchorStart = tok.start;
    items = _mentionItems(tok.query, reposCache);
    activeIdx = 0;
    positionMenu();
    menu.classList.add('open');
    const palette = inputEl.id === 'cmdPaletteInput' ? inputEl.closest('.cmd-palette') : null;
    if (palette) palette.classList.add('mention-open');
    render();
  };
  inputEl.addEventListener('input', refresh);
  inputEl.addEventListener('keydown', (e) => {
    if (!menu.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % Math.max(1, items.length); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + items.length) % Math.max(1, items.length); render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (items.length) { e.preventDefault(); e.stopPropagation(); pick(activeIdx); }
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }, true);
  inputEl.addEventListener('blur', () => setTimeout(close, 120));
}
// Wire up known composers. (Others can call attachMentions on their own input.)
document.addEventListener('DOMContentLoaded', () => {
  attachMentions(document.getElementById('cmdPaletteInput'));
});

