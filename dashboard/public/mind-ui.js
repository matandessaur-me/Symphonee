/**
 * Mind tab UI.
 *
 * Three views over the same graph:
 *   - communities: card grid, each card is one community with cohesion + top gods
 *   - hotspots:    god nodes ranked + surprises ranked (the "what should I look at?" view)
 *   - graph:       interactive force-directed graph powered by vis-network
 *
 * Side panel on the right shows full node detail when a node is clicked.
 *
 * vis-network is the same library graphify uses for its graph.html output -
 * battle-tested physics, smooth zoom/pan, edge labels on hover, community
 * highlighting, focus animation. Loaded as a global `vis` from the static
 * bundle at /vis-network.min.js.
 */

(function () {
  const API = (path, opts = {}) => fetch(path, opts).then(r => r.json());
  const $ = (id) => document.getElementById(id);

  // Persisted UI prefs for the graph view. Survives tab switches and reloads
  // so a "Show everything" + paused-physics setup stays put when the user
  // wanders off and comes back.
  const PREFS_KEY = 'mind-ui-prefs:v1';
  // Physics default = off (frozen). Stabilization still runs once to lay
  // out the graph, then physics is disabled so weaker machines aren't stuck
  // animating forever. The user can resume it from the Freeze button.
  const DEFAULT_PREFS = { graphCap: '1000', graphFilter: 'all', physicsEnabled: false };
  function loadPrefs() {
    try { return Object.assign({}, DEFAULT_PREFS, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); }
    catch (_) { return Object.assign({}, DEFAULT_PREFS); }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch (_) {}
  }

  let state = {
    view: 'dashboard',
    graph: null,
    selectedNode: null,
    watchEnabled: false,
    network: null,         // vis.Network instance
    visNodes: null,        // vis.DataSet for nodes
    visEdges: null,        // vis.DataSet for edges
    ws: null,
    search: '',            // current search term (lowercased, trimmed)
    matches: [],           // ids of nodes matching state.search, ordered
    matchIndex: 0,         // current cursor for Enter-cycling
    prefs: loadPrefs(),    // persisted graph cap/filter/physics
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  function onActivate() {
    refreshStatus();
    loadGraph().then(render);
    if (!state.ws) connectWS();
    bindSearchInput();
  }

  // ── Search: one input, every view honours state.search ─────────────────────
  // The toolbar input is persistent (lives in the Mind tab, not in any view's
  // body), so we bind once and keep `state.search` as the source of truth.
  // Each renderer reads it; for graph/map we also paint matches on the
  // existing vis-network instance instead of rebuilding.
  let searchBound = false;
  function bindSearchInput() {
    if (searchBound) return;
    const input = $('mindSearchInput');
    if (!input) return;
    searchBound = true;
    let debounceTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => applySearch(input.value), 120);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        cycleMatch(ev.shiftKey ? -1 : 1);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        clearSearch();
      }
    });
  }

  function clearSearch() {
    const input = $('mindSearchInput');
    if (input) input.value = '';
    applySearch('');
  }

  function nodeMatchesSearch(n, q) {
    if (!q) return false;
    if (typeof n.label === 'string' && n.label.toLowerCase().includes(q)) return true;
    if (typeof n.id === 'string' && n.id.toLowerCase().includes(q)) return true;
    if (Array.isArray(n.tags)) {
      for (const t of n.tags) {
        if (typeof t === 'string' && t.toLowerCase().includes(q)) return true;
      }
    }
    return false;
  }

  function recomputeMatches() {
    const q = state.search;
    if (!q || !state.graph) { state.matches = []; state.matchIndex = 0; return; }
    // Rank: label-prefix > label-substring > id/tags. Then by degree desc so
    // important nodes surface first - the user almost always means those.
    const degree = new Map();
    for (const e of state.graph.edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    const scored = [];
    for (const n of state.graph.nodes) {
      if (!nodeMatchesSearch(n, q)) continue;
      const lbl = (n.label || '').toLowerCase();
      let rank = 3;
      if (lbl.startsWith(q)) rank = 0;
      else if (lbl.includes(q)) rank = 1;
      else if ((n.id || '').toLowerCase().includes(q)) rank = 2;
      scored.push({ id: n.id, rank, deg: degree.get(n.id) || 0 });
    }
    scored.sort((a, b) => a.rank - b.rank || b.deg - a.deg);
    state.matches = scored.map(x => x.id);
    state.matchIndex = 0;
  }

  function applySearch(rawQuery) {
    state.search = (rawQuery || '').trim().toLowerCase();
    recomputeMatches();
    updateSearchUi();
    // Re-render the active view. Graph/map prefer in-place re-paint so we
    // don't blow away the network state, but rebuilding is acceptable here -
    // small graphs only - and keeps the code path single.
    if (state.view === 'graph') paintGraphSearch();
    else if (state.view === 'map') paintMapSearch();
    else render();
    // If we have a match, surface it in the detail panel automatically.
    if (state.matches.length) showNodeDetail(state.matches[0]);
  }

  function cycleMatch(step) {
    if (!state.matches.length) return;
    state.matchIndex = (state.matchIndex + step + state.matches.length) % state.matches.length;
    const id = state.matches[state.matchIndex];
    updateSearchUi();
    if (state.view === 'graph') paintGraphSearch(id);
    else if (state.view === 'map') paintMapSearch(id);
    showNodeDetail(id);
  }

  function updateSearchUi() {
    const count = $('mindSearchCount');
    const clear = $('mindSearchClear');
    if (clear) clear.style.display = state.search ? '' : 'none';
    if (!count) return;
    if (!state.search) { count.textContent = ''; return; }
    if (!state.matches.length) { count.textContent = '0'; count.style.color = 'var(--red)'; return; }
    count.style.color = 'var(--subtext0)';
    count.textContent = state.matches.length === 1
      ? '1'
      : `${state.matchIndex + 1}/${state.matches.length}`;
  }

  // Graph view: rebuild the network so match-aware styling lands cleanly,
  // then focus the current cursor. buildNetwork() reads state.search.
  function paintGraphSearch(focusId) {
    if (!state.graph) return;
    const loader = $('mindGraphLoader');
    if (loader) loader.style.display = 'flex';
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          buildNetwork();
          const target = focusId || state.matches[state.matchIndex];
          if (target && state.network) {
            try { state.network.focus(target, { scale: 1.2, animation: { duration: 350, easingFunction: 'easeInOutQuad' } }); } catch (_) {}
          }
        } finally {
          if (loader) loader.style.display = 'none';
        }
      }, 0);
    });
  }

  // Map view: re-render with state.search so community circles tint based on
  // whether they contain a matched node, then focus the relevant community.
  function paintMapSearch(focusId) {
    if (!state.graph) return;
    renderMap();
    if (!state.search) return;
    const matchSet = new Set(state.matches);
    let focusCommunity = null;
    if (focusId) {
      const node = state.graph.nodes.find(n => n.id === focusId);
      if (node && typeof node.communityId === 'number') focusCommunity = 'c' + node.communityId;
    }
    if (!focusCommunity) {
      for (const n of state.graph.nodes) {
        if (matchSet.has(n.id) && typeof n.communityId === 'number') {
          focusCommunity = 'c' + n.communityId;
          break;
        }
      }
    }
    if (focusCommunity && state.network) {
      try { state.network.focus(focusCommunity, { scale: 1.2, animation: { duration: 350 } }); } catch (_) {}
    }
  }

  function connectWS() {
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'mind-update') onMindUpdate(msg.payload);
        } catch (_) {}
      };
      ws.onclose = () => { state.ws = null; setTimeout(connectWS, 3000); };
      state.ws = ws;
    } catch (_) {}
  }

  function onMindUpdate(payload) {
    if (!payload) return;
    if (payload.kind === 'build-progress') setStatus(payload.msg || 'building...');
    if (payload.kind === 'build-complete' || payload.kind === 'update-complete') {
      setStatus('build complete - reloading');
      loadGraph().then(() => { render(); refreshStatus(); });
    }
    if (payload.kind === 'build-failed') setStatus('build failed: ' + (payload.error || 'unknown'));
    if (payload.kind === 'watch-trigger') setStatus('change: ' + (payload.file || ''));
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function loadGraph() {
    const g = await API('/api/mind/graph');
    state.graph = g.empty ? null : g;
    return state.graph;
  }

  async function refreshStatus() {
    const s = await API('/api/mind/stats');
    if (!s.stats) {
      setStatus(`${s.space || 'space'}: empty`);
      return;
    }
    const ageMin = Math.round((Date.now() - new Date(s.stats.lastBuildAt).getTime()) / 60000);
    setStatus(`${s.space}: ${s.stats.nodes} nodes, ${s.stats.edges} edges, ${s.stats.communities} communities, ${ageMin}m ago`);
    const w = await API('/api/mind/watch');
    setWatch(!!w.enabled);
  }

  function setStatus(msg) {
    const el = $('mindStatusLine');
    if (!el) return;
    el.textContent = msg;
    el.title = msg;
  }
  function setWatch(on) {
    state.watchEnabled = on;
    const b = $('mindWatchBtn'); if (b) b.textContent = `Watch: ${on ? 'on' : 'off'}`;
  }

  // ── View routing ───────────────────────────────────────────────────────────
  function setView(view) {
    state.view = view;
    document.querySelectorAll('.mind-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    render();
  }

  function render() {
    teardownNetwork();
    // Graph + Map views need a full-bleed canvas - turn padding/scroll off
    // for those, restore for everything else.
    const main = $('mindMain');
    if (main) {
      const fullBleed = (state.view === 'graph' || state.view === 'map');
      main.style.padding = fullBleed ? '0' : '14px 18px';
      main.style.overflow = fullBleed ? 'hidden' : 'auto';
      main.style.display = fullBleed ? 'flex' : '';
      main.style.flexDirection = fullBleed ? 'column' : '';
    }
    if (!state.graph) {
      $('mindMain').innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--subtext0);">
          <div style="font-size:14px;margin-bottom:8px;color:var(--text);">No brain yet for this space.</div>
          <div style="font-size:12px;margin-bottom:16px;">Run a build to ingest your notes, learnings, CLI memory, recipes, plugins, instructions, and active repo code.</div>
          <button class="tab-bar-btn" onclick="MindUI.build()" style="padding:6px 14px;font-size:12px;">Build the brain</button>
        </div>`;
      return;
    }
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'communities') renderCommunities();
    else if (state.view === 'hotspots') renderHotspots();
    else if (state.view === 'map') renderMap();
    else if (state.view === 'graph') renderGraph();
  }

  // ── Dashboard view (the "dashboard into the brain") ────────────────────────
  function renderDashboard() {
    const g = state.graph;
    const stats = g.stats || {};
    const sources = stats.sources || {};

    // --- aggregations ---
    const kindCounts = {}; const cliCounts = {}; const confCounts = { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 };
    const recent = []; // recent conversation nodes
    for (const n of g.nodes) {
      kindCounts[n.kind] = (kindCounts[n.kind] || 0) + 1;
      const cb = n.createdBy || 'unknown';
      cliCounts[cb] = (cliCounts[cb] || 0) + 1;
      if (n.kind === 'conversation') recent.push(n);
    }
    for (const e of g.edges) confCounts[e.confidence] = (confCounts[e.confidence] || 0) + 1;
    recent.sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));

    const totalEdges = g.edges.length || 1;
    const lastBuildAt = stats.buildMs ? `${(stats.buildMs / 1000).toFixed(1)}s build` : '';
    const ageMin = g.generatedAt ? Math.round((Date.now() - new Date(g.generatedAt).getTime()) / 60000) : 0;

    const html = `
      <div class="mind-dash">
        ${renderSearchResultsPanel()}
        <div class="mind-stat-strip">
          ${statCard('Nodes', stats.nodes ?? g.nodes.length, '#89b4fa')}
          ${statCard('Edges', stats.edges ?? g.edges.length, '#a6e3a1')}
          ${statCard('Communities', stats.communities ?? Object.keys(g.communities || {}).length, '#fab387')}
          ${statCard('Sources', Object.keys(sources).length || '-', '#cba6f7')}
          ${statCard('God nodes', (g.gods || []).length, '#f9e2af')}
          ${statCard('Bridges', (g.surprises || []).length, '#f38ba8')}
          ${statCard('Last build', `${ageMin}m ago`, '#94e2d5', lastBuildAt)}
          ${statCard('Watch', state.watchEnabled ? 'on' : 'off', state.watchEnabled ? '#a6e3a1' : '#6c7086')}
        </div>

        <div class="mind-dash-grid">
          <div class="mind-card">
            <div class="mind-card-title">Sources contribution</div>
            ${barChart(Object.entries(sources).map(([k, v]) => ({ label: k, value: v.nodes || 0, hint: `${v.scanned ?? '?'} scanned` })), 12)}
          </div>

          <div class="mind-card">
            <div class="mind-card-title">Edge confidence</div>
            <div style="display:flex;align-items:center;gap:14px;">
              ${donut([
                { label: 'EXTRACTED', value: confCounts.EXTRACTED, color: '#a6e3a1' },
                { label: 'INFERRED',  value: confCounts.INFERRED,  color: '#f9e2af' },
                { label: 'AMBIGUOUS', value: confCounts.AMBIGUOUS, color: '#f38ba8' },
              ], 110)}
              <div style="flex:1;font-size:11px;display:flex;flex-direction:column;gap:4px;">
                ${legendItem('#a6e3a1', 'EXTRACTED', confCounts.EXTRACTED, totalEdges)}
                ${legendItem('#f9e2af', 'INFERRED',  confCounts.INFERRED,  totalEdges)}
                ${legendItem('#f38ba8', 'AMBIGUOUS', confCounts.AMBIGUOUS, totalEdges)}
              </div>
            </div>
          </div>

          <div class="mind-card">
            <div class="mind-card-title">Nodes by kind</div>
            ${barChart(Object.entries(kindCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v })), 10)}
          </div>

          <div class="mind-card">
            <div class="mind-card-title">Contributors (createdBy)</div>
            ${barChart(Object.entries(cliCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => ({ label: k, value: v, color: cliColor(k) })), 8)}
          </div>

          <div class="mind-card">
            <div class="mind-card-title">Top god nodes</div>
            <div class="mind-list">
              ${(g.gods || []).slice(0, 10).map(x => godRow(x, (g.gods[0]?.degree || 1))).join('')}
            </div>
          </div>

          <div class="mind-card">
            <div class="mind-card-title">Largest communities</div>
            <div class="mind-list">
              ${Object.entries(g.communities || {}).sort((a, b) => b[1].size - a[1].size).slice(0, 10).map(([cid, c]) => communityRow(cid, c)).join('')}
            </div>
          </div>

          <div class="mind-card mind-card-wide">
            <div class="mind-card-title">Recent CLI conversations</div>
            ${recent.length === 0
              ? '<div style="color:var(--subtext0);font-size:11px;font-style:italic;padding:6px;">no conversations yet - dispatch a worker via the orchestrator and Mind will save it here automatically</div>'
              : '<div class="mind-feed">' + recent.slice(0, 12).map(convRow).join('') + '</div>'}
          </div>

          <div class="mind-card mind-card-wide">
            <div class="mind-card-title">Surprising bridges (cross-community)</div>
            <div class="mind-list">
              ${(g.surprises || []).slice(0, 8).map(s => surpriseRow(g, s)).join('') || '<div style="color:var(--subtext0);font-size:11px;font-style:italic;padding:6px;">no cross-community bridges yet</div>'}
            </div>
          </div>
        </div>
      </div>
      <style>
        .mind-dash { display:flex; flex-direction:column; gap:14px; }
        .mind-stat-strip { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:10px; }
        @media (max-width: 900px) { .mind-stat-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        .mind-stat-card { background:var(--mantle); border:1px solid var(--surface1); border-radius:6px; padding:10px 12px; display:flex; flex-direction:column; gap:2px; }
        .mind-stat-card .mind-stat-label { font-size:10px; color:var(--subtext0); text-transform:uppercase; letter-spacing:0.5px; }
        .mind-stat-card .mind-stat-value { font-size:20px; font-weight:600; color:var(--text); font-variant-numeric:tabular-nums; }
        .mind-stat-card .mind-stat-hint  { font-size:10px; color:var(--subtext0); }
        .mind-dash-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:12px; }
        .mind-card { background:var(--mantle); border:1px solid var(--surface1); border-radius:6px; padding:12px; }
        .mind-card-wide { grid-column: 1 / -1; }
        .mind-card-title { font-size:11px; font-weight:600; color:var(--subtext0); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; }
        .mind-bar { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text); }
        .mind-bar-label { min-width:80px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--subtext0); }
        .mind-bar-track { flex:1; height:6px; background:var(--surface0); border-radius:3px; overflow:hidden; }
        .mind-bar-fill  { height:100%; border-radius:3px; }
        .mind-bar-num   { min-width:40px; text-align:right; color:var(--subtext1); font-variant-numeric:tabular-nums; font-size:10px; }
        .mind-list { display:flex; flex-direction:column; gap:5px; }
        .mind-feed { display:flex; flex-direction:column; gap:6px; max-height:400px; overflow:auto; }
        .mind-feed-row { padding:7px 9px; background:var(--base); border-radius:4px; cursor:pointer; transition: background 0.1s; }
        .mind-feed-row:hover { background:var(--surface0); }
        .mind-feed-row .mind-feed-meta { display:flex; align-items:center; gap:8px; font-size:10px; color:var(--subtext0); margin-bottom:3px; }
        .mind-feed-row .mind-cli-badge { padding:1px 6px; border-radius:8px; font-size:9px; font-weight:600; text-transform:uppercase; }
        .mind-feed-row .mind-feed-text { font-size:11px; color:var(--text); overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
        .mind-surprise-row {
          display:grid;
          grid-template-columns: minmax(0, 1fr) 90px minmax(0, 1fr) 70px;
          align-items:center; gap:8px;
          font-size:11px; padding:5px 10px;
          background:var(--base); border-radius:4px;
        }
        .mind-surprise-row > .mind-surprise-src,
        .mind-surprise-row > .mind-surprise-tgt {
          color:var(--accent); text-decoration:none;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .mind-surprise-row > .mind-surprise-rel {
          color:var(--subtext0); font-size:10px;
          text-align:center;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .mind-surprise-row > .mind-surprise-com {
          color:var(--subtext0); font-size:10px;
          text-align:right; font-variant-numeric:tabular-nums;
        }
      </style>`;
    $('mindMain').innerHTML = html;
    $('mindMain').querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', (ev) => { ev.preventDefault(); showNodeDetail(el.dataset.id); });
    });
    $('mindMain').querySelectorAll('[data-cid]').forEach(el => {
      el.addEventListener('click', (ev) => { ev.preventDefault(); showCommunityDetail(el.dataset.cid); });
    });
  }

  function statCard(label, value, color, hint) {
    return `<div class="mind-stat-card"><div class="mind-stat-label">${escapeHtml(label)}</div><div class="mind-stat-value" style="color:${color}">${escapeHtml(String(value))}</div>${hint ? `<div class="mind-stat-hint">${escapeHtml(hint)}</div>` : ''}</div>`;
  }

  function barChart(rows, maxRows) {
    if (!rows || rows.length === 0) return '<div style="color:var(--subtext0);font-size:11px;font-style:italic;">empty</div>';
    const cap = Math.max(1, ...rows.map(r => r.value));
    return '<div class="mind-list">' + rows.slice(0, maxRows || 12).map(r => {
      const pct = (r.value / cap) * 100;
      const color = r.color || '#89b4fa';
      return `<div class="mind-bar"><div class="mind-bar-label" title="${escapeHtml(r.label)}${r.hint ? ' (' + escapeHtml(r.hint) + ')' : ''}">${escapeHtml(r.label)}</div><div class="mind-bar-track"><div class="mind-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div><div class="mind-bar-num">${escapeHtml(String(r.value))}</div></div>`;
    }).join('') + '</div>';
  }

  function donut(slices, size) {
    const total = slices.reduce((s, x) => s + x.value, 0) || 1;
    const r = size / 2 - 8;
    const cx = size / 2, cy = size / 2;
    let acc = 0;
    const arcs = slices.map(s => {
      const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
      acc += s.value;
      const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
      const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
      const large = end - start > Math.PI ? 1 : 0;
      if (s.value === 0) return '';
      return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z" fill="${s.color}" stroke="var(--mantle)" stroke-width="2"></path>`;
    }).join('');
    const inner = r * 0.55;
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${arcs}<circle cx="${cx}" cy="${cy}" r="${inner}" fill="var(--mantle)"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="13" fill="var(--text)" font-family="monospace">${total}</text></svg>`;
  }

  function legendItem(color, label, value, total) {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;background:${color};border-radius:2px;flex-shrink:0;"></span><span style="color:var(--subtext1);min-width:80px;">${label}</span><span style="color:var(--text);font-variant-numeric:tabular-nums;">${value}</span><span style="color:var(--subtext0);font-size:10px;">(${pct}%)</span></div>`;
  }

  function godRow(x, max) {
    const pct = (x.degree / max) * 100;
    return `<div class="mind-bar" data-id="${escapeHtml(x.id)}" style="cursor:pointer;"><div class="mind-bar-label" style="color:var(--text);" title="${escapeHtml(x.label)}">${escapeHtml(x.label)}</div><div class="mind-bar-track"><div class="mind-bar-fill" style="width:${pct.toFixed(1)}%;background:#fab387"></div></div><div class="mind-bar-num">${x.degree}</div></div>`;
  }

  function communityRow(cid, c) {
    const cohesionPct = Math.round((c.cohesion || 0) * 100);
    return `<div class="mind-bar" data-cid="${escapeHtml(cid)}" style="cursor:pointer;"><div class="mind-bar-label" style="color:var(--text);" title="${escapeHtml(c.label)}">#${cid} ${escapeHtml(c.label)}</div><div class="mind-bar-track"><div class="mind-bar-fill" style="width:${Math.min(100, c.size / 2)}%;background:${communityColor(parseInt(cid, 10))}"></div></div><div class="mind-bar-num">${c.size} - ${cohesionPct}%</div></div>`;
  }

  function convRow(n) {
    const cli = (n.createdBy || 'unknown').split('-')[0]; // strip "claude-code" -> "claude"
    const color = cliColor(cli);
    const date = n.createdAt ? new Date(n.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const tags = (n.tags || []).filter(t => !['cli-session', 'conversation', cli].includes(t)).slice(0, 3).map(t => `<span style="font-size:9px;color:var(--subtext0);">#${escapeHtml(t)}</span>`).join(' ');
    return `<div class="mind-feed-row" data-id="${escapeHtml(n.id)}">
      <div class="mind-feed-meta"><span class="mind-cli-badge" style="background:${color};color:#1e1e2e;">${escapeHtml(cli)}</span><span>${escapeHtml(date)}</span>${tags}</div>
      <div class="mind-feed-text">${escapeHtml(n.preview || n.label)}</div>
    </div>`;
  }

  function surpriseRow(g, s) {
    return `<div class="mind-surprise-row">
      <a href="#" data-id="${escapeHtml(s.source)}" class="mind-surprise-src">${escapeHtml(nodeLabel(g, s.source))}</a>
      <span class="mind-surprise-rel">${escapeHtml(s.relation)}</span>
      <a href="#" data-id="${escapeHtml(s.target)}" class="mind-surprise-tgt">${escapeHtml(nodeLabel(g, s.target))}</a>
      <span class="mind-surprise-com">c${s.crossesCommunities.join('/')}</span>
    </div>`;
  }

  // Compact search result list used by the Dashboard view. Other views handle
  // search inline (filter cards / paint canvas) so they don't need this.
  function renderSearchResultsPanel() {
    if (!state.search) return '';
    const g = state.graph;
    if (!g) return '';
    const matchSet = state.matches.slice(0, 30);
    const empty = matchSet.length === 0;
    const rows = matchSet.map(id => {
      const n = g.nodes.find(x => x.id === id);
      if (!n) return '';
      const color = communityColor(n.communityId);
      return `<a href="#" data-id="${escapeHtml(n.id)}" style="display:flex;align-items:baseline;gap:8px;padding:5px 9px;background:var(--base);border-radius:4px;text-decoration:none;color:var(--text);font-size:11px;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(n.label)}</span>
        <span style="font-size:10px;color:var(--subtext0);">${escapeHtml(n.kind)}</span>
        ${n.communityId != null ? `<span style="font-size:9px;color:${color};">c${n.communityId}</span>` : ''}
      </a>`;
    }).join('');
    return `
      <div style="background:var(--mantle);border:1px solid var(--surface1);border-radius:6px;padding:10px 12px;margin-bottom:14px;">
        <div style="font-size:10px;font-weight:700;color:var(--subtext0);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline;">
          <span>Search: "${escapeHtml(state.search)}"</span>
          <span style="font-weight:500;">${state.matches.length} match${state.matches.length === 1 ? '' : 'es'}${state.matches.length > 30 ? ' (showing 30)' : ''}</span>
        </div>
        ${empty ? '<div style="font-size:11px;color:var(--subtext0);font-style:italic;">No nodes match.</div>' : `<div style="display:flex;flex-direction:column;gap:3px;">${rows}</div>`}
      </div>`;
  }

  function cliColor(name) {
    const map = {
      claude: '#fab387', codex: '#a6e3a1', gemini: '#89b4fa', copilot: '#cba6f7',
      grok: '#f38ba8', qwen: '#f9e2af', orchestrator: '#94e2d5',
    };
    return map[name] || '#9399b2';
  }

  // ── Map view: communities as super-nodes (vis-network) ─────────────────────
  function renderMap() {
    const main = $('mindMain');
    if (typeof window.vis === 'undefined') {
      main.innerHTML = `<div style="padding:20px;color:var(--red);">vis-network failed to load.</div>`;
      return;
    }
    const g = state.graph;
    const communities = g.communities || {};
    const cIds = Object.keys(communities);
    if (cIds.length === 0) {
      main.innerHTML = `<div style="padding:30px;text-align:center;color:var(--subtext0);">No communities yet.</div>`;
      return;
    }

    main.innerHTML = `
      <div style="font-size:11px;color:var(--subtext0);flex-shrink:0;padding:8px 12px;border-bottom:1px solid var(--surface0);background:var(--mantle);">
        Each circle is a community. Edges show cross-community bridges (sized by traffic). Click a circle to drill in.
      </div>
      <div id="mindCanvasHost" style="flex:1;min-height:0;width:100%;background:var(--mantle);"></div>`;

    // Aggregate cross-community edge counts.
    const idCommunity = new Map();
    for (const [cid, c] of Object.entries(communities)) {
      for (const nid of c.nodeIds) idCommunity.set(nid, +cid);
    }
    const bridgeCount = new Map(); // "a|b" -> count
    for (const e of g.edges) {
      const ca = idCommunity.get(e.source); const cb = idCommunity.get(e.target);
      if (ca == null || cb == null || ca === cb) continue;
      const key = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
      bridgeCount.set(key, (bridgeCount.get(key) || 0) + 1);
    }

    // If a search is active, figure out which communities contain matches.
    const matchSet = state.search ? new Set(state.matches) : null;
    const matchedCommunities = new Set();
    if (matchSet) {
      for (const n of g.nodes) {
        if (matchSet.has(n.id) && typeof n.communityId === 'number') {
          matchedCommunities.add(String(n.communityId));
        }
      }
    }

    const nodes = cIds.map(cid => {
      const c = communities[cid];
      const baseColor = communityColor(parseInt(cid, 10));
      const isMatch = matchedCommunities.has(cid);
      const dim = matchSet && !isMatch;
      const fill = isMatch ? '#f9e2af' : (dim ? 'rgba(108,112,134,0.3)' : baseColor);
      const border = isMatch ? '#f9e2af' : (dim ? 'rgba(108,112,134,0.3)' : baseColor);
      return {
        id: 'c' + cid,
        label: `#${cid}\n${c.label.slice(0, 28)}`,
        title: `${c.label}\n${c.size} nodes - cohesion ${Math.round((c.cohesion || 0) * 100)}%`,
        shape: 'dot',
        size: Math.min(70, Math.max(15, 15 + Math.sqrt(c.size) * 4)),
        borderWidth: isMatch ? 4 : 1,
        color: { background: fill, border, highlight: { background: '#fff', border } },
        font: { color: dim ? 'rgba(205,214,244,0.35)' : '#cdd6f4', size: 10, face: 'monospace', strokeWidth: 0, multi: true },
      };
    });
    const edges = Array.from(bridgeCount.entries()).map(([key, count], i) => {
      const [a, b] = key.split('|');
      return {
        id: 'b' + i,
        from: 'c' + a, to: 'c' + b,
        title: `${count} bridge edge${count !== 1 ? 's' : ''}`,
        width: Math.min(8, Math.max(1, Math.log2(count + 1))),
        color: { color: 'rgba(245,194,231,0.4)', highlight: '#cba6f7' },
        smooth: { enabled: true, type: 'continuous' },
      };
    });

    teardownNetwork();
    state.visNodes = new vis.DataSet(nodes);
    state.visEdges = new vis.DataSet(edges);
    state.network = new vis.Network($('mindCanvasHost'), { nodes: state.visNodes, edges: state.visEdges }, {
      physics: {
        solver: 'forceAtlas2Based',
        forceAtlas2Based: { gravitationalConstant: -120, centralGravity: 0.02, springLength: 140, springConstant: 0.1, damping: 0.55 },
        stabilization: { enabled: true, iterations: 200, fit: true },
      },
      interaction: { hover: true, tooltipDelay: 150, dragView: true, zoomView: true },
    });
    state.network.on('click', (params) => {
      if (params.nodes && params.nodes.length) {
        const cid = params.nodes[0].slice(1); // strip leading "c"
        showCommunityDetail(cid);
      }
    });
    state.network.on('stabilizationIterationsDone', () => {
      // Same rule as the Graph view: respect the user's physics pref once
      // the initial layout settles. Defaults to frozen (see DEFAULT_PREFS).
      try {
        state.network.setOptions({ physics: { stabilization: { enabled: false }, enabled: state.prefs.physicsEnabled !== false } });
      } catch (_) {}
    });
  }

  function renderCommunities() {
    const g = state.graph;
    let cards = Object.entries(g.communities || {})
      .map(([cid, c]) => ({ cid, ...c }))
      .sort((a, b) => b.size - a.size);
    // Search: keep only communities containing at least one matched node.
    if (state.search && state.matches.length) {
      const matchSet = new Set(state.matches);
      cards = cards.filter(c => (c.nodeIds || []).some(nid => matchSet.has(nid)));
    } else if (state.search) {
      cards = [];
    }
    const html = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">
        ${cards.map(c => communityCard(c, g)).join('')}
      </div>`;
    $('mindMain').innerHTML = html;
    $('mindMain').querySelectorAll('.mind-comm-card').forEach(card => {
      card.addEventListener('click', (ev) => {
        const cid = card.dataset.cid;
        if (ev.target.classList.contains('mind-godlink')) return;
        showCommunityDetail(cid);
      });
    });
    $('mindMain').querySelectorAll('.mind-godlink').forEach(a => {
      a.addEventListener('click', (ev) => { ev.preventDefault(); showNodeDetail(a.dataset.id); });
    });
  }

  function communityCard(c, g) {
    const idSet = new Set(c.nodeIds);
    const inCommunityGods = (g.gods || []).filter(x => idSet.has(x.id)).slice(0, 3);
    const cohesionPct = Math.round((c.cohesion || 0) * 100);
    const cohesionColor = c.cohesion > 0.4 ? 'var(--green)' : c.cohesion > 0.15 ? 'var(--yellow)' : 'var(--subtext0)';
    return `
      <div class="mind-comm-card" data-cid="${c.cid}" style="border:1px solid var(--surface1);border-radius:6px;padding:12px;background:var(--mantle);cursor:pointer;transition:border-color 0.15s;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">#${c.cid} ${escapeHtml(c.label || 'cluster')}</div>
          <div style="font-size:10px;color:${cohesionColor};font-variant-numeric:tabular-nums;">${cohesionPct}%</div>
        </div>
        <div style="font-size:10px;color:var(--subtext0);margin-bottom:8px;">${c.size} nodes</div>
        <div style="display:flex;flex-direction:column;gap:3px;">
          ${inCommunityGods.length === 0
            ? '<div style="font-size:10px;color:var(--subtext0);font-style:italic;">no high-degree anchors</div>'
            : inCommunityGods.map(x => `<a class="mind-godlink" href="#" data-id="${x.id}" style="font-size:11px;color:var(--accent);text-decoration:none;display:flex;align-items:baseline;justify-content:space-between;gap:8px;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(x.label)}</span><span style="color:var(--subtext0);font-size:10px;font-variant-numeric:tabular-nums;">deg ${x.degree}</span></a>`).join('')}
        </div>
      </div>`;
  }

  function renderHotspots() {
    const g = state.graph;
    let gods = g.gods || [];
    let surprises = g.surprises || [];
    if (state.search) {
      const matchSet = new Set(state.matches);
      gods = gods.filter(x => matchSet.has(x.id));
      surprises = surprises.filter(s => matchSet.has(s.source) || matchSet.has(s.target));
    }
    const html = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--subtext0);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">God nodes (most connected)</div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${gods.slice(0, 25).map(g => `
              <a href="#" class="mind-godlink" data-id="${g.id}" style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:6px 10px;background:var(--mantle);border-radius:4px;text-decoration:none;color:var(--text);font-size:12px;">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(g.label)}</span>
                <span style="color:var(--subtext0);font-size:10px;font-variant-numeric:tabular-nums;">${g.degree}</span>
              </a>`).join('')}
          </div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--subtext0);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Surprising bridges (cross-community edges)</div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${surprises.length === 0 ? '<div style="color:var(--subtext0);font-size:11px;font-style:italic;padding:6px;">no cross-community bridges yet - build the brain with more sources</div>' : surprises.slice(0, 25).map(s => `
              <div style="padding:6px 10px;background:var(--mantle);border-radius:4px;font-size:11px;display:flex;flex-direction:column;gap:2px;">
                <div style="display:flex;align-items:baseline;gap:6px;">
                  <a href="#" class="mind-godlink" data-id="${s.source}" style="color:var(--accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;">${escapeHtml(nodeLabel(g, s.source))}</a>
                  <span style="color:var(--subtext0);">${s.relation}</span>
                  <a href="#" class="mind-godlink" data-id="${s.target}" style="color:var(--accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%;">${escapeHtml(nodeLabel(g, s.target))}</a>
                </div>
                <div style="color:var(--subtext0);font-size:10px;">communities ${s.crossesCommunities.join(' / ')} · ${s.confidence}</div>
              </div>`).join('')}
          </div>
        </div>
      </div>`;
    $('mindMain').innerHTML = html;
    $('mindMain').querySelectorAll('.mind-godlink').forEach(a => {
      a.addEventListener('click', (ev) => { ev.preventDefault(); showNodeDetail(a.dataset.id); });
    });
  }

  // ── Graph view (vis-network) ───────────────────────────────────────────────
  function renderGraph() {
    const main = $('mindMain');
    if (typeof window.vis === 'undefined') {
      main.innerHTML = `<div style="padding:20px;color:var(--red);">vis-network failed to load. Check that /vis-network.min.js is reachable.</div>`;
      return;
    }
    main.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;padding:8px 12px;border-bottom:1px solid var(--surface0);background:var(--mantle);">
        <div style="font-size:11px;color:var(--subtext0);flex:1;min-width:0;">
          Drag nodes - scroll to zoom - hover edges for relation - click node for detail. Solid = EXTRACTED, dashed = INFERRED, dotted-red = AMBIGUOUS.
        </div>
        <select id="mindGraphFilter" style="background:var(--surface0);color:var(--text);border:1px solid var(--surface1);border-radius:4px;padding:3px 6px;font-size:11px;">
          <option value="all">All node kinds</option>
          <option value="code">code only</option>
          <option value="doc">docs only</option>
          <option value="note">notes only</option>
          <option value="concept">concepts only</option>
          <option value="plugin">plugins only</option>
          <option value="conversation">conversations only</option>
        </select>
        <select id="mindGraphCap" style="background:var(--surface0);color:var(--text);border:1px solid var(--surface1);border-radius:4px;padding:3px 6px;font-size:11px;" title="How many nodes to draw. Lower = snappier and easier to read.">
          <option value="500" title="Snappy. Most-connected nodes only. Easy to read.">Light (500)</option>
          <option value="1000" selected title="Balanced default - structure is visible, layout is fast.">Default (1000)</option>
          <option value="2000" title="Shows the long tail too. Slower layout, denser canvas.">Important (2000)</option>
          <option value="all" title="Every node. Slow layout, hairball view - search to navigate.">Everything</option>
        </select>
        <button class="tab-bar-btn" onclick="MindUI.fitGraph()" style="font-size:11px;" title="Fit graph to view">Fit</button>
        <button class="tab-bar-btn" onclick="MindUI.togglePhysics()" id="mindPhysicsBtn" style="font-size:11px;" title="Pause/resume layout physics">Freeze</button>
      </div>
      <div id="mindCanvasHost" style="flex:1;min-height:0;width:100%;background:var(--mantle);position:relative;">
        <div id="mindGraphLoader" class="mind-loader-overlay" style="display:none;">
          <div class="mind-spinner"></div>
          <div class="mind-loader-text">Laying out graph...</div>
        </div>
      </div>`;

    // Hydrate the controls from saved prefs before the first build so we
    // don't waste a layout on the wrong cap.
    const filterEl = $('mindGraphFilter');
    const capEl = $('mindGraphCap');
    if (filterEl) filterEl.value = state.prefs.graphFilter;
    if (capEl) capEl.value = state.prefs.graphCap;
    updatePhysicsBtnLabel();

    buildNetworkAsync();
    filterEl.addEventListener('change', () => {
      state.prefs.graphFilter = filterEl.value;
      savePrefs();
      buildNetworkAsync();
    });
    capEl.addEventListener('change', () => {
      state.prefs.graphCap = capEl.value;
      savePrefs();
      buildNetworkAsync();
    });
  }

  // Wraps buildNetwork() so the loader overlay actually paints before the
  // synchronous DataSet construction + vis.Network init blocks the main thread.
  // Without the rAF + setTimeout chain the browser batches the style change
  // with the heavy work and the user sees a frozen screen for top 2000/5000.
  function buildNetworkAsync() {
    const loader = $('mindGraphLoader');
    if (loader) loader.style.display = 'flex';
    requestAnimationFrame(() => {
      setTimeout(() => {
        try { buildNetwork(); } finally {
          if (loader) loader.style.display = 'none';
        }
      }, 0);
    });
  }

  // Catppuccin Mocha-ish 12-color palette - readable on dark bg
  const PALETTE = ['#89b4fa', '#f38ba8', '#a6e3a1', '#fab387', '#cba6f7', '#94e2d5', '#f9e2af', '#74c7ec', '#eba0ac', '#b4befe', '#f5c2e7', '#89dceb'];
  function communityColor(cid) {
    if (typeof cid !== 'number') return '#9399b2';
    return PALETTE[cid % PALETTE.length];
  }

  const KIND_SHAPE = {
    code: 'dot', doc: 'square', note: 'star', plugin: 'diamond',
    recipe: 'triangle', tag: 'dot', concept: 'dot', conversation: 'hexagon',
    workitem: 'box', image: 'image', paper: 'square',
  };

  function nodeSize(degree) {
    return Math.min(40, Math.max(8, 8 + Math.sqrt(degree) * 3));
  }

  function buildNetwork() {
    const g = state.graph;
    const host = $('mindCanvasHost');
    if (!host || !g) return;

    const filter = $('mindGraphFilter')?.value || 'all';
    const capRaw = $('mindGraphCap')?.value || '1000';
    // "all" = no cap (Everything option). Anything else parses to a node count.
    const cap = capRaw === 'all' ? Infinity : parseInt(capRaw, 10);

    let nodes = g.nodes;
    if (filter !== 'all') nodes = nodes.filter(n => n.kind === filter);

    // Compute degree for sizing AND for top-N filtering at the cap.
    const degree = new Map();
    for (const e of g.edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    if (nodes.length > cap) {
      const ranked = nodes.slice().sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
      const top = ranked.slice(0, cap);
      // If a search is active, ensure matched nodes always survive the cap -
      // otherwise the user searches for a low-degree node and it disappears.
      if (state.search && state.matches.length) {
        const seen = new Set(top.map(n => n.id));
        const matchSet = new Set(state.matches);
        for (const n of nodes) {
          if (!seen.has(n.id) && matchSet.has(n.id)) top.push(n);
        }
      }
      nodes = top;
    }
    const idSet = new Set(nodes.map(n => n.id));
    const edges = g.edges.filter(e => idSet.has(e.source) && idSet.has(e.target));

    const matchSet = state.search ? new Set(state.matches) : null;
    const visNodes = nodes.map(n => {
      const baseColor = communityColor(n.communityId);
      const isMatch = matchSet ? matchSet.has(n.id) : false;
      const dim = !!matchSet && !isMatch;
      // Highlight: yellow fill + thicker border. Dim: shrink alpha via a muted
      // grey so non-matches recede without disappearing.
      const fill = isMatch ? '#f9e2af' : (dim ? 'rgba(108,112,134,0.25)' : baseColor);
      const border = isMatch ? '#f9e2af' : (dim ? 'rgba(108,112,134,0.25)' : baseColor);
      const fontColor = dim ? 'rgba(205,214,244,0.35)' : '#cdd6f4';
      return {
        id: n.id,
        label: n.label.length > 36 ? n.label.slice(0, 33) + '...' : n.label,
        title: `${n.label}\nkind: ${n.kind}\ncommunity: ${n.communityId ?? '-'}\nid: ${n.id}`,
        shape: KIND_SHAPE[n.kind] || 'dot',
        size: nodeSize(degree.get(n.id) || 0),
        borderWidth: isMatch ? 3 : 1,
        color: { background: fill, border, highlight: { background: '#fff', border } },
        font: { color: fontColor, size: 11, face: 'monospace', strokeWidth: 0 },
        group: typeof n.communityId === 'number' ? `c${n.communityId}` : 'unset',
      };
    });

    const visEdges = edges.map((e, i) => {
      const styles = e.confidence === 'EXTRACTED'
        ? { dashes: false, color: 'rgba(180,190,254,0.45)' }
        : e.confidence === 'INFERRED'
        ? { dashes: [6, 4], color: 'rgba(245,194,231,0.45)' }
        : { dashes: [2, 4], color: 'rgba(243,139,168,0.65)' };
      return {
        id: `e${i}`,
        from: e.source,
        to: e.target,
        title: `${e.relation} (${e.confidence})`,
        arrows: { to: { enabled: true, scaleFactor: 0.4 } },
        smooth: { enabled: true, type: 'continuous' },
        width: 0.6,
        ...styles,
      };
    });

    teardownNetwork();
    state.visNodes = new vis.DataSet(visNodes);
    state.visEdges = new vis.DataSet(visEdges);
    state.network = new vis.Network(host, { nodes: state.visNodes, edges: state.visEdges }, {
      autoResize: true,
      interaction: {
        hover: true, tooltipDelay: 150, navigationButtons: false, keyboard: false,
        multiselect: false, dragView: true, zoomView: true,
      },
      physics: {
        solver: 'forceAtlas2Based',
        forceAtlas2Based: { gravitationalConstant: -55, centralGravity: 0.01, springLength: 90, springConstant: 0.08, damping: 0.5 },
        stabilization: { enabled: true, iterations: 250, fit: true, updateInterval: 25 },
        maxVelocity: 60, minVelocity: 0.6,
      },
      nodes: { borderWidth: 1, scaling: { label: { enabled: true, min: 8, max: 14 } } },
      edges: { selectionWidth: 1.5 },
    });

    state.network.on('click', (params) => {
      if (params.nodes && params.nodes.length) {
        state.selectedNode = params.nodes[0];
        showNodeDetail(params.nodes[0]);
      }
    });
    state.network.on('stabilizationIterationsDone', () => {
      // Pin the first stabilization end so the user can interact without
      // the whole graph re-flowing on every click. If the user previously
      // froze physics, honour that on the rebuilt network too.
      try {
        state.network.setOptions({ physics: { stabilization: { enabled: false }, enabled: state.prefs.physicsEnabled !== false } });
      } catch (_) {}
      updatePhysicsBtnLabel();
    });
  }

  function updatePhysicsBtnLabel() {
    const btn = $('mindPhysicsBtn');
    if (!btn) return;
    btn.textContent = state.prefs.physicsEnabled === false ? 'Resume' : 'Freeze';
  }

  function teardownNetwork() {
    if (state.network) { try { state.network.destroy(); } catch (_) {} state.network = null; }
    state.visNodes = null;
    state.visEdges = null;
  }

  function fitGraph() { if (state.network) state.network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } }); }

  function togglePhysics() {
    if (!state.network) return;
    const cur = state.network.physics.physicsEnabled;
    const next = !cur;
    state.network.setOptions({ physics: { enabled: next } });
    state.prefs.physicsEnabled = next;
    savePrefs();
    updatePhysicsBtnLabel();
  }

  // ── Detail side panel ──────────────────────────────────────────────────────
  async function showNodeDetail(id) {
    state.selectedNode = id;
    const detail = $('mindDetail');
    detail.style.display = 'block';
    detail.innerHTML = '<div style="color:var(--subtext0);font-size:11px;">Loading...</div>';
    try {
      const r = await API('/api/mind/node?id=' + encodeURIComponent(id));
      if (r.error) { detail.innerHTML = `<div style="color:var(--red);font-size:11px;">${r.error}</div>`; return; }
      const n = r.node;
      const neighbors = r.neighbors || [];
      const kindColor = communityColor(n.communityId) || '#9399b2';
      const cb = (n.createdBy || 'system').split('-')[0];
      const cliC = cliColor(cb);
      const created = n.createdAt ? formatTimestamp(n.createdAt) : '?';

      detail.innerHTML = `
        <div class="mind-detail">
          <div class="mind-detail-head">
            <div class="mind-detail-title">
              <div class="mind-detail-kind-dot" style="background:${kindColor};"></div>
              <div class="mind-detail-label" title="${escapeHtml(n.label)}">${escapeHtml(n.label)}</div>
            </div>
            <button class="tab-bar-btn mind-detail-close" onclick="MindUI.closeDetail()" title="Close">×</button>
          </div>

          <div class="mind-chip-row">
            <span class="mind-chip" style="background:${kindColor}22;color:${kindColor};">${escapeHtml(n.kind)}</span>
            ${n.communityId != null ? `<span class="mind-chip mind-chip-link" data-cid="${escapeHtml(String(n.communityId))}" style="background:${communityColor(n.communityId)}22;color:${communityColor(n.communityId)};cursor:pointer;" title="Open community #${n.communityId}">community #${n.communityId}</span>` : ''}
            <span class="mind-chip" style="background:${cliC}22;color:${cliC};">${escapeHtml(cb)}</span>
            ${(n.tags || []).filter(t => t && t !== n.kind && t !== cb).slice(0, 4).map(t => `<span class="mind-chip mind-chip-tag">#${escapeHtml(t)}</span>`).join('')}
          </div>

          <div class="mind-detail-meta">
            ${metaRow('Created', escapeHtml(created))}
            ${n.source ? renderSource(n.source) : ''}
            ${n.sourceLocation ? renderLocation(n.sourceLocation) : ''}
            ${metaRow('ID', `<code class="mind-id">${escapeHtml(n.id)}</code>`, true)}
          </div>

          ${n.preview || n.detail || n.answer || n.result ? `
            <div class="mind-detail-section">
              <div class="mind-detail-section-title">${n.preview ? 'Preview' : n.answer ? 'Answer' : n.result ? 'Result' : 'Detail'}</div>
              <div class="mind-detail-prose">${escapeHtml((n.preview || n.detail || n.answer || n.result || '').slice(0, 1200))}</div>
            </div>` : ''}

          <div class="mind-detail-section">
            <div class="mind-detail-section-title">Neighbors <span class="mind-section-count">${neighbors.length}</span></div>
            <div class="mind-neighbors">
              ${neighbors.length === 0 ? '<div class="mind-empty">no connections</div>' : neighbors.slice(0, 60).map(nb => neighborRow(nb)).join('')}
            </div>
          </div>

          <div class="mind-detail-actions">
            <button class="tab-bar-btn" onclick="MindUI.askAbout('${encodeURIComponent(n.label)}')" style="flex:1;font-size:11px;">Ask Mind about this</button>
            <button class="tab-bar-btn mind-detail-purge" onclick="MindUI.purgeNode('${encodeURIComponent(n.id)}')" title="Delete this node from the graph">Purge</button>
          </div>
        </div>
        <style>
          .mind-detail { display:flex; flex-direction:column; gap:14px; }
          .mind-detail-head { display:flex; align-items:flex-start; gap:8px; padding-bottom:10px; border-bottom:1px solid var(--surface0); }
          .mind-detail-title { flex:1; display:flex; align-items:flex-start; gap:8px; min-width:0; }
          .mind-detail-kind-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; margin-top:5px; }
          .mind-detail-label { font-size:13px; font-weight:600; color:var(--text); line-height:1.35; word-break:break-word; }
          .mind-detail-close { padding:0 8px; font-size:14px; line-height:1; }
          .mind-chip-row { display:flex; flex-wrap:wrap; gap:4px; }
          .mind-chip { font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; padding:2px 7px; border-radius:10px; }
          .mind-chip-link:hover { filter:brightness(1.3); }
          .mind-chip-tag { background:var(--surface0); color:var(--subtext0); font-weight:500; text-transform:none; letter-spacing:0; }
          .mind-detail-meta { display:grid; grid-template-columns:auto 1fr; column-gap:10px; row-gap:5px; font-size:11px; }
          .mind-meta-key { color:var(--subtext0); text-transform:uppercase; font-size:9.5px; letter-spacing:0.5px; padding-top:2px; }
          .mind-meta-val { color:var(--text); word-break:break-all; }
          .mind-meta-val-mono { font-family:var(--font-mono, monospace); font-size:10px; color:var(--subtext1); }
          .mind-id { font-family:var(--font-mono, monospace); font-size:10px; background:var(--surface0); color:var(--subtext1); padding:1px 5px; border-radius:3px; word-break:break-all; }
          .mind-path { font-family:var(--font-mono, monospace); font-size:10px; color:var(--text); background:var(--surface0); padding:2px 5px; border-radius:3px; display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom; }
          .mind-detail-section { display:flex; flex-direction:column; gap:6px; }
          .mind-detail-section-title { font-size:10px; font-weight:700; color:var(--subtext0); text-transform:uppercase; letter-spacing:0.6px; display:flex; align-items:center; gap:6px; }
          .mind-section-count { background:var(--surface0); color:var(--subtext0); padding:0 6px; border-radius:8px; font-weight:500; font-size:9.5px; }
          .mind-detail-prose { font-size:11px; color:var(--text); background:var(--base); padding:8px 10px; border-radius:4px; line-height:1.5; max-height:200px; overflow:auto; white-space:pre-wrap; }
          .mind-empty { font-size:11px; color:var(--subtext0); font-style:italic; padding:6px; }
          .mind-neighbors { display:flex; flex-direction:column; gap:3px; max-height:280px; overflow:auto; padding-right:2px; }
          .mind-nb-row { display:flex; align-items:center; gap:6px; padding:5px 8px; background:var(--base); border-radius:3px; font-size:11px; color:var(--text); text-decoration:none; cursor:pointer; transition:background 0.1s; border-left:2px solid transparent; }
          .mind-nb-row:hover { background:var(--surface0); border-left-color:var(--accent); }
          .mind-nb-arrow { color:var(--subtext0); font-size:11px; min-width:14px; text-align:center; }
          .mind-nb-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .mind-nb-rel { color:var(--subtext0); font-size:10px; padding:1px 5px; background:var(--surface0); border-radius:3px; }
          .mind-nb-conf { font-size:9px; font-weight:700; min-width:10px; text-align:center; }
          .mind-detail-actions { display:flex; gap:6px; padding-top:8px; border-top:1px solid var(--surface0); }
          .mind-detail-purge { font-size:11px; color:var(--red); padding:0 12px; }
        </style>`;
      detail.querySelectorAll('.mind-nb-row').forEach(a => {
        a.addEventListener('click', (ev) => { ev.preventDefault(); if (a.dataset.id) showNodeDetail(a.dataset.id); });
      });
      detail.querySelectorAll('.mind-chip-link').forEach(a => {
        a.addEventListener('click', (ev) => { ev.preventDefault(); if (a.dataset.cid != null) showCommunityDetail(a.dataset.cid); });
      });
      detail.querySelectorAll('.mind-neighbor-link').forEach(a => {
        a.addEventListener('click', (ev) => { ev.preventDefault(); if (a.dataset.id) showNodeDetail(a.dataset.id); });
      });
    } catch (e) {
      detail.innerHTML = `<div style="color:var(--red);font-size:11px;">${e.message}</div>`;
    }
  }

  async function showCommunityDetail(cid) {
    const detail = $('mindDetail');
    detail.style.display = 'block';
    const r = await API('/api/mind/community?id=' + encodeURIComponent(cid));
    if (r.error) { detail.innerHTML = `<div style="color:var(--red);font-size:11px;">${r.error}</div>`; return; }
    detail.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">#${r.id} ${escapeHtml(r.label || 'cluster')}</div>
        <span style="flex:1;"></span>
        <button class="tab-bar-btn" onclick="MindUI.closeDetail()" title="Close">×</button>
      </div>
      <div style="font-size:11px;color:var(--subtext0);margin-bottom:10px;">
        ${r.size} nodes · cohesion ${Math.round((r.cohesion || 0) * 100)}%
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;">
        ${(r.nodes || []).slice(0, 100).map(n => `
          <a href="#" class="mind-neighbor-link" data-id="${n.id}" style="display:flex;align-items:baseline;gap:6px;padding:4px 6px;background:var(--base);border-radius:3px;text-decoration:none;font-size:11px;color:var(--text);">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(n.label)}</span>
            <span style="color:var(--subtext0);font-size:10px;">${escapeHtml(n.kind)}</span>
          </a>`).join('')}
      </div>`;
    detail.querySelectorAll('.mind-neighbor-link').forEach(a => {
      a.addEventListener('click', (ev) => { ev.preventDefault(); showNodeDetail(a.dataset.id); });
    });
  }

  function closeDetail() { $('mindDetail').style.display = 'none'; state.selectedNode = null; }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function build() {
    setStatus('starting build...');
    await API('/api/mind/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }
  async function update() {
    setStatus('starting incremental update...');
    await API('/api/mind/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }
  async function toggleWatch() {
    const next = !state.watchEnabled;
    await API('/api/mind/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
    setWatch(next);
  }
  async function askAbout(labelEnc) {
    const q = decodeURIComponent(labelEnc);
    const r = await API('/api/mind/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, budget: 1200 }) });
    const detail = $('mindDetail');
    detail.style.display = 'block';
    detail.innerHTML = `
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Query: ${escapeHtml(q)}</div>
      <div style="font-size:11px;color:var(--subtext0);margin-bottom:8px;">Sub-graph: ${r.nodes?.length || 0} nodes / ${r.edges?.length || 0} edges (~${r.estTokens || 0} tokens)</div>
      <div style="background:var(--base);padding:8px;border-radius:4px;font-size:11px;color:var(--text);margin-bottom:8px;">${escapeHtml(r.answer?.summary || '')}</div>
      <div style="font-size:10px;color:var(--subtext0);font-style:italic;">${escapeHtml(r.answer?.note || '')}</div>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:3px;">
        ${(r.nodes || []).slice(0, 50).map(n => `<a href="#" class="mind-neighbor-link" data-id="${n.id}" style="font-size:11px;color:var(--accent);text-decoration:none;padding:3px 6px;background:var(--mantle);border-radius:3px;">${escapeHtml(n.label)} <span style="color:var(--subtext0);">(${escapeHtml(n.kind)})</span></a>`).join('')}
      </div>`;
    detail.querySelectorAll('.mind-neighbor-link').forEach(a => {
      a.addEventListener('click', (ev) => { ev.preventDefault(); showNodeDetail(a.dataset.id); });
    });
  }
  async function purgeNode(idEnc) {
    const id = decodeURIComponent(idEnc);
    if (!confirm('Purge node ' + id + ' from the graph?')) return;
    await API('/api/mind/node', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    closeDetail();
    loadGraph().then(render);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function nodeLabel(g, id) {
    const n = g.nodes.find(x => x.id === id);
    return n ? n.label : id;
  }
  function confColor(c) { return c === 'EXTRACTED' ? 'var(--green)' : c === 'INFERRED' ? 'var(--yellow)' : 'var(--red)'; }
  function escapeHtml(s) { if (typeof s !== 'string') s = String(s ?? ''); return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function metaRow(key, valueHtml, mono) {
    return `<div class="mind-meta-key">${escapeHtml(key)}</div><div class="mind-meta-val${mono ? ' mind-meta-val-mono' : ''}">${valueHtml}</div>`;
  }

  function shortPath(p) {
    if (!p) return '';
    const norm = String(p).replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    if (parts.length <= 3) return norm;
    return '.../' + parts.slice(-3).join('/');
  }

  // source object -> readable rows. Skips noise, formats files/refs nicely.
  function renderSource(src) {
    if (!src || typeof src !== 'object') return '';
    const rows = [];
    if (src.type) rows.push(metaRow('Source', `<span class="mind-chip" style="background:var(--surface0);color:var(--subtext1);">${escapeHtml(src.type)}</span>`));
    if (src.cli)  rows.push(metaRow('CLI', `<span class="mind-chip" style="background:${cliColor(src.cli)}22;color:${cliColor(src.cli)};">${escapeHtml(src.cli)}</span>`));
    if (src.file) rows.push(metaRow('File', `<span class="mind-path" title="${escapeHtml(src.file)}">${escapeHtml(shortPath(src.file))}</span>`));
    if (src.ref && src.ref !== src.file) rows.push(metaRow('Ref', `<span title="${escapeHtml(src.ref)}">${escapeHtml(shortPath(src.ref))}</span>`));
    if (src.cwd)  rows.push(metaRow('Repo', `<span class="mind-path" title="${escapeHtml(src.cwd)}">${escapeHtml(shortPath(src.cwd))}</span>`));
    if (src.sessionId) rows.push(metaRow('Session', `<code class="mind-id">${escapeHtml(String(src.sessionId).slice(0, 16))}</code>`));
    if (src.model) rows.push(metaRow('Model', escapeHtml(src.model)));
    if (src.url)  rows.push(metaRow('URL', `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener" style="color:var(--accent);">${escapeHtml(src.url)}</a>`));
    return rows.join('');
  }

  function renderLocation(loc) {
    if (!loc || typeof loc !== 'object') return '';
    const parts = [];
    if (loc.file) parts.push(`<span class="mind-path" title="${escapeHtml(loc.file)}">${escapeHtml(shortPath(loc.file))}</span>`);
    if (loc.line) parts.push(`<span style="color:var(--subtext0);">L${loc.line}</span>`);
    if (loc.column) parts.push(`<span style="color:var(--subtext0);">C${loc.column}</span>`);
    if (parts.length === 0) return '';
    return metaRow('Location', parts.join(' '));
  }

  function neighborRow(nb) {
    const peer = nb.peer; const e = nb.edge;
    const id = peer?.id || e.target;
    const arrow = nb.direction === 'out' ? '&#x2192;' : '&#x2190;';
    const label = peer?.label || (nb.direction === 'out' ? e.target : e.source);
    const conf = e.confidence || '';
    const c = confColor(conf);
    return `<div class="mind-nb-row" data-id="${escapeHtml(id)}" title="${escapeHtml(label)}">
      <span class="mind-nb-arrow">${arrow}</span>
      <span class="mind-nb-label">${escapeHtml(label)}</span>
      <span class="mind-nb-rel">${escapeHtml(e.relation)}</span>
      <span class="mind-nb-conf" style="color:${c};" title="${escapeHtml(conf)}">${conf ? conf[0] : '?'}</span>
    </div>`;
  }

  function formatTimestamp(iso) {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = now - d.getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
      if (diff < 604800000) return Math.round(diff / 86400000) + 'd ago';
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return iso; }
  }

  window.MindUI = { onActivate, setView, build, update, toggleWatch, askAbout, purgeNode, closeDetail, fitGraph, togglePhysics, clearSearch };
})();
