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
  const DEFAULT_PREFS = { graphCap: '1000', graphFilter: 'all', physicsEnabled: false, searchOnly: false };
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
    graphBuildSeq: 0,      // increments per graph rebuild so stale completions are ignored
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
    updateSearchOnlyBtn();
    refreshLock();
    refreshQuality();
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
      } else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && state.matches.length) {
        // Cycle matches with arrow keys when a search is active. Lets the user
        // sweep through hits without leaving the input.
        ev.preventDefault();
        cycleMatch(ev.key === 'ArrowRight' ? 1 : -1);
      }
    });
  }

  function toggleSearchOnly() {
    state.prefs.searchOnly = !state.prefs.searchOnly;
    savePrefs();
    updateSearchOnlyBtn();
    // Re-render the active view so the new mode lands. Same dispatch as
    // applySearch(): graph/map paint in place, others rebuild.
    if (state.view === 'graph') paintGraphSearch();
    else if (state.view === 'map') paintMapSearch();
    else render();
  }

  function updateSearchOnlyBtn() {
    const btn = $('mindSearchOnlyBtn');
    if (!btn) return;
    const on = !!state.prefs.searchOnly;
    btn.textContent = on ? 'Search only: on' : 'Search only: off';
    btn.style.color = on ? 'var(--accent)' : 'var(--subtext0)';
    btn.style.borderColor = on ? 'var(--accent)' : 'var(--surface1)';
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
    buildNetworkAsync({
      focusId: focusId || state.matches[state.matchIndex],
      loaderText: state.prefs.graphCap === 'all' ? 'Refreshing full graph...' : 'Refreshing graph...',
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
    if (payload.kind === 'build-start') refreshLock();
    if (payload.kind === 'build-progress') { setStatus(payload.msg || 'building...'); refreshLock(); }
    if (payload.kind === 'build-complete' || payload.kind === 'update-complete') {
      setStatus('build complete - reloading');
      loadGraph().then(() => { render(); refreshStatus(); refreshLock(); refreshQuality(); });
    }
    if (payload.kind === 'build-failed') { setStatus('build failed: ' + (payload.error || 'unknown')); refreshLock(); }
    if (payload.kind === 'watch-trigger') setStatus('change: ' + (payload.file || ''));
    if (payload.kind === 'embed-progress') setStatus(payload.msg || 'embedding...');
    if (payload.kind === 'embed-complete') {
      setStatus(`embedded ${(payload.result && payload.result.embedded) || 0} nodes`);
      refreshSmartHealth && refreshSmartHealth();
    }
    if (payload.kind === 'embed-failed') setStatus('embed failed: ' + (payload.error || 'unknown'));
  }
  async function refreshQuality() {
    try {
      const r = await API('/api/mind/quality');
      const pill = document.getElementById('mindQualityPill');
      const txt = document.getElementById('mindQualityText');
      if (!pill || !txt) return;
      if (!r || typeof r.resolvedPct !== 'number' || r.totalImportEdges === 0) {
        pill.style.display = 'none';
        return;
      }
      pill.style.display = 'inline-flex';
      txt.textContent = `quality ${r.resolvedPct}%`;
      pill.title = `Resolved ${r.resolvedPct}% of ${r.totalImportEdges} import edges. ${r.unresolvedExamples?.length || 0} unresolved examples.`;
    } catch (_) { /* ignore */ }
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

  function showGraphLoader(text) {
    const loader = $('mindGraphLoader');
    if (!loader) return;
    const textEl = loader.querySelector('.mind-loader-text');
    if (textEl) textEl.textContent = text || 'Laying out graph...';
    loader.style.display = 'flex';
  }

  function hideGraphLoader() {
    const loader = $('mindGraphLoader');
    if (loader) loader.style.display = 'none';
  }

  function focusGraphNode(focusId) {
    if (!focusId || !state.network) return;
    try {
      state.network.focus(focusId, { scale: 1.2, animation: { duration: 350, easingFunction: 'easeInOutQuad' } });
    } catch (_) {}
  }

  // ── View routing ───────────────────────────────────────────────────────────
  // Aliases keep saved-state and old links working after the consolidation.
  const VIEW_ALIASES = {
    graph: 'mindmap',
    map: 'mindmap',
    smart: 'search',
    query: 'search',
    wakeup: 'dashboard',
    communities: 'mindmap',
    hotspots: 'dashboard',
  };

  function setView(view) {
    const resolved = VIEW_ALIASES[view] || view;
    state.view = resolved;
    document.querySelectorAll('.mind-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === resolved));
    render();
  }

  function render() {
    teardownNetwork();
    // Mind map view always full-bleed (its own ribbon + body manage padding).
    const main = $('mindMain');
    if (main) {
      const fullBleed = (state.view === 'mindmap');
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
    else if (state.view === 'search') renderSearch();
    else if (state.view === 'impact') renderImpact();
    else if (state.view === 'knowledge') renderKnowledge();
    else if (state.view === 'mindmap') renderMindmap();
  }

  // ── Unified Search view (replaces both Query and Smart search) ──────────
  // Single tab. Auto-uses hybrid (BM25 + dense) when vectors are loaded;
  // falls back to BM25-only otherwise. Shows score badges per result so
  // the user sees why each result ranked.
  async function renderSearch() { return renderSmart(); }

  // ── Unified Mind map view ───────────────────────────────────────────────
  // Persistent sub-ribbon + dedicated body. Body contents swap based on
  // mode (graph / map / mermaid); the ribbon stays put so switching view
  // never feels like leaving the tab.
  function renderMindmap() {
    // Mermaid removed from the segmented control - kept as a one-click "Copy
    // mermaid source" action for pasting into chat / docs context.
    let mode = state.mindmapMode || 'graph';
    if (mode === 'mermaid') mode = state.mindmapMode = 'graph';
    const main = $('mindMain');
    if (!main) return;
    main.innerHTML = `
      <div class="mindmap-ribbon">
        <div class="mindmap-segctl" role="tablist" aria-label="Mind map view">
          <button class="mindmap-seg-btn${mode === 'graph' ? ' active' : ''}" data-mode="graph">Graph</button>
          <button class="mindmap-seg-btn${mode === 'map' ? ' active' : ''}" data-mode="map">Map</button>
        </div>
        <span class="mindmap-ribbon-spacer"></span>
        <span class="mindmap-ribbon-hint" id="mindmapHint">${mindmapHint(mode)}</span>
        <span class="mindmap-ribbon-spacer"></span>
        <button class="mindmap-ribbon-btn" id="mindmapCopyMermaid" title="Copy a mermaid source representation for pasting into chat / docs">Copy mermaid</button>
      </div>
      <div id="mindmapBody" class="mindmap-body"></div>`;
    main.querySelectorAll('.mindmap-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.mindmapMode = btn.dataset.mode;
        render();
      });
    });
    const copyBtn = main.querySelector('#mindmapCopyMermaid');
    if (copyBtn) copyBtn.addEventListener('click', copyMermaidSource);
    renderInBody(mode);
  }

  function mindmapHint(mode) {
    if (mode === 'map') return 'Each circle is a community. Edges show cross-community bridges.';
    return 'Full graph - drag, zoom, click any node to inspect.';
  }

  // Copy mermaid source on demand. Fetches /api/mind/visualize {mode:mermaid}
  // and writes the text to the clipboard. Useful for pasting Mind context
  // into chat or documentation.
  async function copyMermaidSource() {
    setStatus('generating mermaid source...');
    try {
      const r = await fetch('/api/mind/visualize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'mermaid', max: 80 }),
      });
      const d = await r.json();
      if (!d.mermaid) { setStatus(d.error || 'no mermaid output'); return; }
      try { await navigator.clipboard.writeText(d.mermaid); setStatus('mermaid source copied'); }
      catch (_) { setStatus('clipboard unavailable'); }
    } catch (e) {
      setStatus('mermaid error: ' + (e.message || e));
    }
  }

  // Graph + Map: existing renderers fully overwrite #mindMain. To keep the
  // ribbon, we let them render, then the next render() call will rebuild
  // the ribbon on top. To avoid that ping-pong here, we wrap the existing
  // renderer in a temporary id swap: rename mindMain -> mindmap-host,
  // rename mindmapBody -> mindMain, run the renderer (it writes into the
  // body), then restore IDs.
  function renderInBody(mode) {
    const main = document.getElementById('mindMain');
    const body = document.getElementById('mindmapBody');
    if (!main || !body) return;
    main.id = '__mindmap_host';
    body.id = 'mindMain';
    try {
      if (mode === 'graph') renderGraph();
      else if (mode === 'map') renderMap();
    } finally {
      // Restore IDs so subsequent calls to $('mindMain') hit the real one.
      body.id = 'mindmapBody';
      main.id = 'mindMain';
    }
  }

  // ── Smart search (hybrid BM25 + dense via RRF) ──────────────────────────
  async function renderSmart() {
    const main = $('mindMain');
    if (!main) return;
    const last = state.smart || {};
    main.innerHTML = `
      <div class="mind-card" style="max-width:1100px;margin:0 auto;">
        <div class="mind-card-title">Smart search</div>
        <div style="font-size:12px;color:var(--subtext0);margin-bottom:12px;line-height:1.6;">
          Hybrid BM25 + semantic search. Each result shows why it ranked: <b>BM25</b> = literal-token match, <b>Dense</b> = semantic similarity via embeddings.
          Need to enable embeddings first? <button onclick="MindUI._embedAll()" style="background:transparent;border:none;color:var(--accent);text-decoration:underline;cursor:pointer;font-size:12px;">embed the whole graph</button>.
        </div>
        <div id="mindSmartHealth" style="font-size:10px;color:var(--subtext0);margin-bottom:10px;font-variant-numeric:tabular-nums;"></div>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input id="mindSmartQ" type="text" placeholder="ask anything: 'how does auth work', 'where do we mount the orchestrator', 'tsconfig path aliases'" autofocus
            style="flex:1;padding:8px 10px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:13px;" value="${escapeHtml(last.q || '')}">
          <input id="mindSmartK" type="number" min="3" max="50" value="${last.k || 12}"
            style="width:60px;padding:8px 6px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:12px;">
          <button class="tab-bar-btn" onclick="MindUI._smartRun()" style="padding:8px 16px;font-size:12px;">Search</button>
        </div>
        <div id="mindSmartOut" style="font-size:12px;color:var(--text);"></div>
      </div>`;
    const inp = $('mindSmartQ');
    if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSmart(); });
    refreshSmartHealth();
  }

  async function refreshSmartHealth() {
    try {
      const r = await API('/api/mind/health');
      const el = $('mindSmartHealth');
      if (!el) return;
      const e = r.embeddings || {};
      const v = r.vectors || {};
      const eOk = e.ok ? `<span style="color:var(--green);">${escapeHtml(e.provider || '')} ok (${e.latencyMs || 0}ms, ${e.dimensions || '?'}d)</span>` :
        `<span style="color:var(--red);">${escapeHtml(e.provider || 'embed')} unavailable: ${escapeHtml((e.error || '').slice(0, 80))}</span>`;
      const vOk = v.count > 0 ? `<span style="color:var(--green);">${v.count} vectors indexed (${v.dim}d, ${escapeHtml(v.provider || '')})</span>` :
        '<span style="color:var(--yellow);">no vectors yet — click "embed the whole graph"</span>';
      el.innerHTML = `embeddings: ${eOk} · index: ${vOk}`;
    } catch (_) { /* ignore */ }
  }

  async function runSmart() {
    const q = ($('mindSmartQ') && $('mindSmartQ').value || '').trim();
    const k = parseInt(($('mindSmartK') && $('mindSmartK').value) || '12', 10);
    state.smart = { q, k };
    const out = $('mindSmartOut');
    if (!out) return;
    if (!q) { out.innerHTML = '<span style="color:var(--subtext0);">enter a query</span>'; return; }
    out.innerHTML = '<span style="color:var(--subtext0);">searching...</span>';
    try {
      // Run BM25 (via /api/mind/query seedIds extraction) + dense in parallel
      const [bmRes, denseRes] = await Promise.all([
        fetch('/api/mind/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, budget: 800, hybrid: false }) }).then(r => r.json()),
        fetch('/api/mind/search-semantic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, k }) }).then(r => r.json()),
      ]);
      const bmIds = (bmRes.seedIds || []).slice(0, k);
      const bmRank = new Map(bmIds.map((id, i) => [id, i]));
      const denseRank = new Map();
      const denseScore = new Map();
      (denseRes.results || []).forEach((r, i) => { denseRank.set(r.id, i); denseScore.set(r.id, r.score); });
      // RRF locally
      const k_rrf = 60;
      const fused = new Map();
      const allIds = new Set([...bmRank.keys(), ...denseRank.keys()]);
      for (const id of allIds) {
        let s = 0;
        if (bmRank.has(id)) s += 1 / (k_rrf + bmRank.get(id));
        if (denseRank.has(id)) s += 1 / (k_rrf + denseRank.get(id));
        fused.set(id, s);
      }
      const ranked = Array.from(fused.entries()).sort((a, b) => b[1] - a[1]).slice(0, k);
      const nodeMap = new Map();
      for (const n of (bmRes.nodes || [])) nodeMap.set(n.id, n);
      for (const r of (denseRes.results || [])) if (r.node) nodeMap.set(r.id, r.node);
      out.innerHTML = ranked.map(([id, score], rank) => {
        const node = nodeMap.get(id);
        const bm = bmRank.has(id) ? `<span style="color:var(--green);">BM25 #${bmRank.get(id) + 1}</span>` : '';
        const dn = denseRank.has(id) ? `<span style="color:var(--accent);">Dense #${denseRank.get(id) + 1} (${(denseScore.get(id) || 0).toFixed(2)})</span>` : '';
        const both = [bm, dn].filter(Boolean).join(' · ');
        const label = node ? escapeHtml(node.label) : escapeHtml(id);
        const kind = node ? `<span style="color:var(--subtext0);font-size:10px;">[${escapeHtml(node.kind || '')}]</span>` : '';
        return `
          <a href="#" class="mind-smart-link" data-id="${escapeHtml(id)}" style="display:block;padding:8px 10px;background:var(--mantle);border:1px solid var(--surface0);border-radius:4px;margin-bottom:6px;text-decoration:none;color:var(--text);">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">
                <span style="font-size:11px;color:var(--subtext0);font-variant-numeric:tabular-nums;">#${rank + 1}</span>
                ${label} ${kind}
              </div>
              <div style="font-size:10px;display:flex;gap:8px;flex-shrink:0;">${both}</div>
            </div>
          </a>`;
      }).join('') || '<span style="color:var(--subtext0);">no matches</span>';
      out.querySelectorAll('.mind-smart-link').forEach(a => {
        a.addEventListener('click', (ev) => { ev.preventDefault(); showNodeDetail(a.dataset.id); });
      });
    } catch (e) {
      out.innerHTML = `<span style="color:var(--red);">error: ${escapeHtml(e.message || String(e))}</span>`;
    }
  }

  async function embedAll() {
    if (!confirm('Embed the whole graph? This will call your embedding provider for ~hundreds of nodes.')) return;
    setStatus('starting embedding...');
    try {
      await fetch('/api/mind/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      refreshSmartHealth();
    } catch (_) { /* ignore */ }
  }

  // ── Impact view (symbols + blast-radius + call-flow + entrypoints) ──────
  async function renderImpact() {
    const main = $('mindMain');
    if (!main) return;
    main.innerHTML = `
      <div class="mind-card" style="max-width:1200px;margin:0 auto;">
        <div class="mind-card-title">Impact analysis</div>
        <div style="font-size:12px;color:var(--subtext0);margin-bottom:14px;line-height:1.6;">
          Symbol-level call graph. <b>What breaks if I rename X?</b> · <b>What does this entrypoint actually do?</b> · <b>Who calls Y and what does Y call?</b>
        </div>
        <div id="mindCircularBanner" style="display:none;margin-bottom:12px;"></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;">
          <div style="background:var(--base);border:1px solid var(--surface0);border-radius:6px;padding:12px;">
            <div style="font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--subtext0);text-transform:uppercase;margin-bottom:8px;">Blast radius</div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
              <input id="mindImpactTarget" type="text" placeholder="symbol name or relative file path" style="flex:1;padding:6px 8px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:12px;">
              <input id="mindImpactDepth" type="number" value="3" min="1" max="8" style="width:54px;padding:6px 8px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:12px;">
              <button class="tab-bar-btn" onclick="MindUI._impactRun()" style="padding:6px 10px;font-size:11px;">Run</button>
            </div>
            <div id="mindImpactOut" style="font-size:11px;color:var(--text);max-height:320px;overflow:auto;"></div>
          </div>
          <div style="background:var(--base);border:1px solid var(--surface0);border-radius:6px;padding:12px;">
            <div style="font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--subtext0);text-transform:uppercase;margin-bottom:8px;">Call flow (forward)</div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
              <input id="mindFlowTarget" type="text" placeholder="entrypoint symbol or file" style="flex:1;padding:6px 8px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:12px;">
              <input id="mindFlowDepth" type="number" value="5" min="1" max="10" style="width:54px;padding:6px 8px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:12px;">
              <button class="tab-bar-btn" onclick="MindUI._flowRun()" style="padding:6px 10px;font-size:11px;">Trace</button>
            </div>
            <div id="mindFlowOut" style="font-size:11px;color:var(--text);max-height:320px;overflow:auto;"></div>
          </div>
          <div style="background:var(--base);border:1px solid var(--surface0);border-radius:6px;padding:12px;">
            <div style="font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--subtext0);text-transform:uppercase;margin-bottom:8px;">Symbol 360°</div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
              <input id="mindSymTarget" type="text" placeholder="symbol name" style="flex:1;padding:6px 8px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:12px;">
              <button class="tab-bar-btn" onclick="MindUI._symbolRun()" style="padding:6px 10px;font-size:11px;">Look up</button>
            </div>
            <div id="mindSymOut" style="font-size:11px;color:var(--text);max-height:320px;overflow:auto;"></div>
          </div>
          <div style="background:var(--base);border:1px solid var(--surface0);border-radius:6px;padding:12px;">
            <div style="font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--subtext0);text-transform:uppercase;margin-bottom:8px;">Entrypoints</div>
            <div id="mindEntrypointsOut" style="font-size:11px;color:var(--text);max-height:380px;overflow:auto;">Loading...</div>
          </div>
        </div>
      </div>`;

    // Auto-load entrypoints + circular detection
    try {
      const r = await fetch('/api/mind/entrypoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await r.json();
      const out = $('mindEntrypointsOut');
      if (out) {
        if (!data.entrypoints || data.entrypoints.length === 0) {
          out.innerHTML = '<span style="color:var(--subtext0);">No entrypoints detected.</span>';
        } else {
          out.innerHTML = data.entrypoints.slice(0, 60).map(e => `
            <div style="padding:6px 8px;border-bottom:1px solid var(--surface0);display:flex;justify-content:space-between;gap:8px;">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">
                <a href="#" class="mind-ep-link" data-ep="${escapeHtml(e.label || e.id)}" style="color:var(--accent);text-decoration:none;">${escapeHtml(e.label)}</a>
                <span style="color:var(--subtext0);font-size:10px;"> ${escapeHtml(e.file || '')}${e.line ? ':' + e.line : ''}</span>
              </div>
              <span style="color:var(--subtext0);font-size:10px;">${escapeHtml((e.reasons || []).join(','))}</span>
            </div>`).join('');
          out.querySelectorAll('.mind-ep-link').forEach(a => {
            a.addEventListener('click', (ev) => {
              ev.preventDefault();
              const t = $('mindFlowTarget');
              if (t) { t.value = a.dataset.ep; runFlow(); }
            });
          });
        }
      }
    } catch (_) { /* ignore */ }

    try {
      const r = await fetch('/api/mind/circular', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await r.json();
      const banner = $('mindCircularBanner');
      if (banner && data.count > 0) {
        banner.style.display = 'block';
        banner.innerHTML = `
          <div style="background:#3b1818;border:1px solid var(--red);color:var(--red);padding:8px 12px;border-radius:4px;font-size:11px;">
            ⚠ ${data.count} circular dependenc${data.count === 1 ? 'y' : 'ies'} detected. ${(data.cycles[0] || []).slice(0, 3).join(' → ')}${(data.cycles[0] || []).length > 3 ? ' →' : ''}
          </div>`;
      } else if (banner) {
        banner.style.display = 'none';
      }
    } catch (_) { /* ignore */ }
  }

  async function runImpact() {
    const target = ($('mindImpactTarget') && $('mindImpactTarget').value || '').trim();
    const depth = parseInt(($('mindImpactDepth') && $('mindImpactDepth').value) || '3', 10);
    const out = $('mindImpactOut');
    if (!out) return;
    if (!target) { out.innerHTML = '<span style="color:var(--subtext0);">enter a symbol name or file path</span>'; return; }
    out.innerHTML = '<span style="color:var(--subtext0);">computing...</span>';
    try {
      const r = await fetch('/api/mind/impact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, depth }) });
      const data = await r.json();
      if (data.error) { out.textContent = data.error; return; }
      const colors = ['#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#94e2d5', '#74c7ec'];
      const hopBlocks = Object.keys(data.filesByDepth || {}).map(hop => {
        const c = colors[(parseInt(hop, 10) - 1) % colors.length];
        const files = data.filesByDepth[hop] || [];
        return `
          <div style="margin-bottom:8px;">
            <div style="font-size:10px;color:${c};font-weight:600;margin-bottom:3px;">Hop ${hop} (${files.length} file${files.length === 1 ? '' : 's'})</div>
            ${files.map(f => `<div style="padding:2px 6px;border-left:2px solid ${c};margin:1px 0;font-family:monospace;">${escapeHtml(f)}</div>`).join('')}
          </div>`;
      }).join('');
      out.innerHTML = `
        <div style="margin-bottom:6px;color:var(--subtext0);">
          ${escapeHtml(data.targetKind)} <b style="color:var(--text);">${escapeHtml(data.target)}</b> · ${data.totalFiles} file${data.totalFiles === 1 ? '' : 's'} affected${data.truncated ? ' (truncated)' : ''}
        </div>
        ${hopBlocks || '<span style="color:var(--subtext0);">no callers found</span>'}`;
    } catch (e) { out.textContent = 'error: ' + (e.message || e); }
  }

  async function runFlow() {
    const target = ($('mindFlowTarget') && $('mindFlowTarget').value || '').trim();
    const depth = parseInt(($('mindFlowDepth') && $('mindFlowDepth').value) || '5', 10);
    const out = $('mindFlowOut');
    if (!out) return;
    if (!target) { out.innerHTML = '<span style="color:var(--subtext0);">pick an entrypoint</span>'; return; }
    out.innerHTML = '<span style="color:var(--subtext0);">tracing...</span>';
    try {
      const r = await fetch('/api/mind/flow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entrypoint: target, depth }) });
      const data = await r.json();
      if (data.error) { out.textContent = data.error; return; }
      function render(node, indent) {
        const pre = '  '.repeat(indent);
        const tail = node.truncated ? ` <span style="color:var(--yellow);">[${node.truncated}]</span>` : '';
        const fileTag = node.file ? `<span style="color:var(--subtext0);font-size:10px;"> ${escapeHtml(node.file)}${node.line ? ':' + node.line : ''}</span>` : '';
        let html = `<div style="font-family:monospace;white-space:pre;">${pre}└ <span style="color:var(--text);">${escapeHtml(node.label)}</span>${fileTag}${tail}</div>`;
        for (const c of node.children || []) html += render(c, indent + 1);
        return html;
      }
      out.innerHTML = render(data.flow, 0);
    } catch (e) { out.textContent = 'error: ' + (e.message || e); }
  }

  async function runSymbol() {
    const name = ($('mindSymTarget') && $('mindSymTarget').value || '').trim();
    const out = $('mindSymOut');
    if (!out) return;
    if (!name) { out.innerHTML = '<span style="color:var(--subtext0);">enter a symbol name</span>'; return; }
    out.innerHTML = '<span style="color:var(--subtext0);">looking up...</span>';
    try {
      const r = await fetch('/api/mind/symbol', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const data = await r.json();
      if (!data.results || data.results.length === 0) {
        out.innerHTML = '<span style="color:var(--subtext0);">no matches</span>';
        return;
      }
      out.innerHTML = data.results.map(s => `
        <div style="margin-bottom:10px;padding:8px;background:var(--mantle);border:1px solid var(--surface0);border-radius:4px;">
          <div style="font-weight:600;color:var(--text);font-size:12px;">${escapeHtml(s.name)} <span style="color:var(--subtext0);font-weight:normal;font-size:10px;">${escapeHtml(s.file || '')}${s.line ? ':' + s.line : ''}</span></div>
          <div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div>
              <div style="color:var(--subtext0);font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Callers (${s.callers.length})</div>
              ${s.callers.slice(0, 12).map(c => `<div style="font-family:monospace;font-size:11px;">← ${escapeHtml(c.name || c.id)} <span style="color:var(--subtext0);font-size:10px;">${escapeHtml(c.file || '')}</span></div>`).join('') || '<span style="color:var(--subtext0);font-size:10px;">none</span>'}
            </div>
            <div>
              <div style="color:var(--subtext0);font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Callees (${s.callees.length})</div>
              ${s.callees.slice(0, 12).map(c => `<div style="font-family:monospace;font-size:11px;">→ ${escapeHtml(c.name || c.id)} <span style="color:var(--subtext0);font-size:10px;">${escapeHtml(c.file || '')}</span></div>`).join('') || '<span style="color:var(--subtext0);font-size:10px;">none</span>'}
            </div>
          </div>
        </div>`).join('');
    } catch (e) { out.textContent = 'error: ' + (e.message || e); }
  }

  // ── Knowledge view (Phase 4 placeholder; populated when artifacts ship) ─
  async function renderKnowledge() {
    const main = $('mindMain');
    if (!main) return;
    main.innerHTML = `
      <div class="mind-card" style="max-width:1100px;margin:0 auto;">
        <div class="mind-card-title">Project knowledge</div>
        <div style="font-size:12px;color:var(--subtext0);margin-bottom:12px;line-height:1.6;">
          Schemas, OpenAPI specs, ADRs, glossaries declared in <code>.symphonee/context-artifacts.json</code>. The AI consults these before answering.
        </div>
        <div id="mindKnowledgeList" style="font-size:12px;color:var(--text);">Loading...</div>
      </div>`;
    try {
      const r = await fetch('/api/mind/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await r.json();
      const list = $('mindKnowledgeList');
      if (!list) return;
      if (!data.artifacts || data.artifacts.length === 0) {
        list.innerHTML = `
          <div style="padding:14px;background:var(--base);border:1px dashed var(--surface1);border-radius:6px;color:var(--subtext0);">
            No artifacts declared. Create <code>.symphonee/context-artifacts.json</code> in the active repo with entries like:
            <pre style="background:var(--mantle);padding:10px;margin-top:8px;border-radius:4px;font-size:11px;color:var(--text);overflow:auto;">{
  "artifacts": [
    { "name": "schema", "path": "./docs/schema.sql",
      "description": "Postgres schema. Check before writing migrations." }
  ]
}</pre>
          </div>`;
        return;
      }
      list.innerHTML = data.artifacts.map(a => `
        <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
            <div style="font-weight:600;font-size:13px;color:var(--text);">${escapeHtml(a.name)}</div>
            <div style="font-size:10px;color:${a.indexed ? 'var(--green)' : 'var(--subtext0)'};">${a.indexed ? 'indexed' : 'not indexed'} · ${a.fileCount || 0} file${(a.fileCount || 0) === 1 ? '' : 's'}</div>
          </div>
          <div style="font-size:11px;color:var(--subtext0);margin:4px 0;">${escapeHtml(a.path || '')}</div>
          <div style="font-size:11px;color:var(--text);line-height:1.5;">${escapeHtml(a.description || '')}</div>
        </div>`).join('');
    } catch (_) { /* ignore */ }
  }

  // ── Wake-up view ──────────────────────────────────────────────────────────
  // Shows the context every dispatched worker starts with. The raw prompt text
  // is still available for debugging, but the primary UI is a structured,
  // user-facing summary instead of a plain text dump.
  async function renderWakeup() {
    const main = $('mindMain');
    if (!main) return;
    const cached = state.wakeup || {};
    main.innerHTML = `
      <div class="mind-card" style="max-width:980px;margin:0 auto;">
        <div class="mind-card-title">Worker context</div>
        <div style="font-size:12px;color:var(--subtext0);margin-bottom:12px;line-height:1.65;">
          This previews the context every dispatched worker starts with. Add a sample task if you want to see how the brain narrows that context for a specific job.
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-bottom:12px;">
          <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">What this shows</div>
            <div style="font-size:11px;color:var(--text);line-height:1.5;">Repo identity, instruction preamble, and the most relevant memory the worker sees first.</div>
          </div>
          <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">Try a sample task</div>
            <div style="font-size:11px;color:var(--text);line-height:1.5;">Use a real task like <span style="color:#89b4fa;">"trace browser router fallback"</span> to preview task-aware context.</div>
          </div>
          <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">Why it matters</div>
            <div style="font-size:11px;color:var(--text);line-height:1.5;">If workers miss obvious context, this view helps explain whether the brain is thin, stale, or too generic.</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center;">
          <input id="mindWakeupQ" type="text" placeholder="Optional: preview a sample task..." style="flex:1;min-width:260px;padding:8px 10px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:12px;" value="${escapeHtml(cached.question || '')}">
          <label style="font-size:11px;color:var(--subtext0);display:flex;align-items:center;gap:4px;" title="Token budget for the wake-up text">
            budget
            <input id="mindWakeupBudget" type="number" min="200" max="2000" step="100" value="${cached.budget || 600}" style="width:74px;padding:4px 6px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:11px;">
          </label>
          <button class="tab-bar-btn" onclick="MindUI._wakeupRefresh()" style="padding:6px 14px;font-size:11px;">Preview context</button>
        </div>
        <div id="mindWakeupMeta" style="font-size:10px;color:var(--subtext0);margin-top:8px;font-variant-numeric:tabular-nums;display:flex;flex-wrap:wrap;gap:14px;"></div>
        <div id="mindWakeupOut" style="display:flex;flex-direction:column;gap:12px;margin-top:12px;"></div>
      </div>`;
    await refreshWakeupOutput();
    const qEl = $('mindWakeupQ');
    if (qEl) qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshWakeupOutput(); });
  }

  async function refreshWakeupOutput() {
    const q = ($('mindWakeupQ') && $('mindWakeupQ').value || '').trim();
    const budget = parseInt(($('mindWakeupBudget') && $('mindWakeupBudget').value) || '600', 10);
    state.wakeup = { question: q, budget };
    const url = `/api/mind/wakeup?budget=${budget}${q ? `&question=${encodeURIComponent(q)}` : ''}`;
    try {
      const data = await API(url);
      const out = $('mindWakeupOut'); const meta = $('mindWakeupMeta');
      if (out) out.innerHTML = renderWakeupPreview(data);
      if (meta) {
        meta.innerHTML = `
          <span>~<strong style="color:var(--text);">${data.estTokens || 0}</strong> tokens</span>
          <span>L0: <strong style="color:var(--text);">${data.layers?.l0Chars || 0}</strong> chars</span>
          <span>L1: <strong style="color:var(--text);">${data.layers?.l1Chars || 0}</strong> chars</span>
          <span>${data.queryAware ? '<strong style="color:#a6e3a1;">task-aware</strong>' : '<strong style="color:var(--subtext0);">generic</strong>'}</span>`;
      }
    } catch (e) {
      const out = $('mindWakeupOut');
      if (out) out.innerHTML = `<div style="background:var(--mantle);border:1px solid var(--surface0);border-radius:6px;padding:14px;color:#f38ba8;">Error: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  // ── Search view ─────────────────────────────────────────────────────────
  // Run a /api/mind/query interactively. The endpoint returns the most
  // relevant nodes in the brain — it does NOT synthesize an answer. Think
  // of this as "find context", not "ask a chatbot". An AI would then
  // consume these nodes to compose an answer.
  async function renderQuery() {
    const main = $('mindMain');
    if (!main) return;
    const c = state.queryUI || {};
    main.innerHTML = `
      <div class="mind-card" style="max-width:980px;margin:0 auto;">
        <div class="mind-card-title">Search the brain</div>
        <div style="font-size:12px;color:var(--subtext0);margin-bottom:12px;line-height:1.65;">
          Search for a topic, feature, file, or past decision. This view finds the most relevant brain entries so an AI can answer with real context.
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-bottom:12px;">
          <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">Best search style</div>
            <div style="font-size:11px;color:var(--text);line-height:1.5;">Use short topics or keywords like <span style="color:#f9e2af;">"browser router fallback"</span> or <span style="color:#89b4fa;">"permission modes"</span>.</div>
          </div>
          <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">What you get back</div>
            <div style="font-size:11px;color:var(--text);line-height:1.5;">Relevant notes, code, docs, and conversations. It is source material, not the final answer.</div>
          </div>
          <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">No results?</div>
            <div style="font-size:11px;color:var(--text);line-height:1.5;">Try broader wording, different keywords, or run a build if this topic has not been indexed yet.</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center;">
          <input id="mindQueryQ" type="text" placeholder="Search by topic or keywords..." style="flex:1;min-width:280px;padding:8px 10px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:12px;" value="${escapeHtml(c.question || '')}">
          <label style="font-size:11px;color:var(--subtext0);display:flex;align-items:center;gap:4px;" title="Filter to facts that were true on this date. Half-open [validFrom, validTo).">
            as of
            <input id="mindQueryAsOf" type="date" value="${escapeHtml(c.asOf || '')}" style="padding:4px 6px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:11px;color-scheme:dark;">
          </label>
          <label style="font-size:11px;color:var(--subtext0);display:flex;align-items:center;gap:4px;" title="Approximate token budget for the returned sub-graph">
            budget
            <input id="mindQueryBudget" type="number" min="200" max="8000" step="100" value="${c.budget || 2000}" style="width:74px;padding:4px 6px;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;color:var(--text);font-size:11px;">
          </label>
          <button class="tab-bar-btn" onclick="MindUI._queryRun()" style="padding:6px 14px;font-size:11px;">Search brain</button>
        </div>
        <div id="mindQueryOut" style="display:flex;flex-direction:column;gap:10px;"></div>
      </div>`;
    const qEl = $('mindQueryQ');
    if (qEl) qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') runQueryFromUi(); });
    if (c.lastResult) renderQueryResult(c.lastResult);
  }

  async function runQueryFromUi() {
    const question = ($('mindQueryQ') && $('mindQueryQ').value || '').trim();
    if (!question) return;
    const asOf = ($('mindQueryAsOf') && $('mindQueryAsOf').value) || null;
    const budget = parseInt(($('mindQueryBudget') && $('mindQueryBudget').value) || '2000', 10);
    state.queryUI = { question, asOf, budget };
    try {
      const data = await fetch('/api/mind/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, asOf: asOf || null, budget }),
      }).then(r => r.json());
      state.queryUI.lastResult = data;
      renderQueryResult(data);
    } catch (e) {
      const out = $('mindQueryOut');
      if (out) out.innerHTML = `<div style="color:#f38ba8;">Error: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  function renderQueryResult(data) {
    const out = $('mindQueryOut');
    if (!out) return;
    if (!data || data.empty || !data.nodes || !data.nodes.length) {
      const note = data && data.empty
        ? 'The brain has nothing on that topic.'
        : 'No matches found.';
      out.innerHTML = `
        <div style="background:var(--mantle);border:1px dashed var(--surface1);border-radius:6px;padding:18px;color:var(--subtext0);font-size:12px;line-height:1.6;">
          <div style="color:var(--text);font-weight:600;margin-bottom:6px;">${escapeHtml(note)}</div>
          <div>Try different keywords, or run a build to ingest more sources. The brain only knows what's been mined.</div>
        </div>`;
      return;
    }
    const seeds = (data.seedIds || []).slice(0, 8);
    const nodes = (data.nodes || []).slice(0, 30);

    const seedsHtml = seeds.length
      ? seeds.map(s => `<span style="background:var(--surface0);padding:2px 8px;border-radius:10px;font-family:monospace;font-size:10px;display:inline-block;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;" title="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join(' ')
      : '<span style="font-style:italic;color:var(--subtext0);">none</span>';

    out.innerHTML = `
      <div style="background:var(--mantle);border:1px solid var(--surface0);border-radius:6px;padding:10px 14px;font-size:11px;color:var(--subtext0);">
        <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 14px;margin-bottom:6px;">
          <span style="text-transform:uppercase;letter-spacing:0.5px;font-size:10px;">Seeds (BM25)</span>
          <span style="flex:1;min-width:0;line-height:1.9;word-break:break-all;">${seedsHtml}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;font-variant-numeric:tabular-nums;">
          <span><strong style="color:var(--text);">${nodes.length}</strong> nodes</span>
          <span><strong style="color:var(--text);">${(data.edges || []).length}</strong> edges</span>
          <span>~<strong style="color:var(--text);">${data.estTokens || 0}</strong> tokens</span>
          <span>as of <strong style="color:var(--text);">${escapeHtml(data.asOf || 'now (timeless)')}</strong></span>
        </div>
      </div>
      <div style="margin-top:8px;display:grid;grid-template-columns:1fr;gap:3px;">
        ${nodes.map(n => `
          <a href="#" class="mind-godlink" data-id="${escapeHtml(n.id)}" style="display:grid;grid-template-columns:120px 1fr;align-items:center;gap:10px;padding:7px 12px;background:var(--mantle);border-radius:4px;text-decoration:none;color:var(--text);font-size:12px;border:1px solid transparent;">
            <span style="font-size:9px;color:var(--subtext0);text-transform:uppercase;letter-spacing:0.5px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">[${escapeHtml(n.kind)}]</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;" title="${escapeHtml(n.label || n.id)}">${escapeHtml(n.label || n.id)}</span>
          </a>`).join('')}
      </div>`;
    out.querySelectorAll('.mind-godlink').forEach(a => a.addEventListener('click', (ev) => {
      ev.preventDefault();
      showNodeDetail(a.dataset.id);
    }));
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
    const maxCommunitySize = Math.max(1, ...Object.values(g.communities || {}).map(c => c.size || 0));
    const maxGodDegree = g.gods[0]?.degree || 1;
    const topContributors = Object.entries(cliCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const maxContributorCount = Math.max(1, ...topContributors.map(([, v]) => v));

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
            <div class="mind-list mind-rank-list">
              ${topContributors.map(([k, v]) => contributorRow(k, v, maxContributorCount)).join('')}
            </div>
          </div>

          <div class="mind-card">
            <div class="mind-card-title">Top god nodes</div>
            <div class="mind-list mind-rank-list">
              ${(g.gods || []).slice(0, 10).map(x => godRow(x, maxGodDegree)).join('')}
            </div>
          </div>

          <div class="mind-card">
            <div class="mind-card-title">Largest communities</div>
            <div class="mind-list mind-rank-list">
              ${Object.entries(g.communities || {}).sort((a, b) => b[1].size - a[1].size).slice(0, 10).map(([cid, c]) => communityRow(cid, c, maxCommunitySize)).join('')}
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

          <div class="mind-card mind-card-wide">
            <div class="mind-card-title">Diagnostics</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px;">
              <button class="tab-bar-btn" onclick="MindUI._wakeupOpen()" style="padding:5px 12px;font-size:11px;" title="Preview the context every dispatched worker starts with">Preview worker context</button>
              <button class="tab-bar-btn" onclick="MindUI._embedAll()" style="padding:5px 12px;font-size:11px;" title="Re-embed all eligible nodes for semantic search">Embed all nodes</button>
              <button class="tab-bar-btn" onclick="MindUI._healthCheck()" style="padding:5px 12px;font-size:11px;" title="Embedding provider + vector index status">Check health</button>
              <span id="mindDiagOut" style="color:var(--subtext0);font-family:monospace;font-size:10px;"></span>
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
        .mind-dash-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:12px; align-items:stretch; }
        .mind-card { background:var(--mantle); border:1px solid var(--surface1); border-radius:6px; padding:12px; display:flex; flex-direction:column; min-height:0; }
        .mind-card-wide { grid-column: 1 / -1; }
        .mind-card-title { font-size:11px; font-weight:600; color:var(--subtext0); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px; }
        .mind-bar { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text); }
        .mind-bar-label { min-width:80px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--subtext0); }
        .mind-bar-track { flex:1; height:6px; background:var(--surface0); border-radius:3px; overflow:hidden; }
        .mind-bar-fill  { height:100%; border-radius:3px; }
        .mind-bar-num   { min-width:40px; text-align:right; color:var(--subtext1); font-variant-numeric:tabular-nums; font-size:10px; }
        .mind-list { display:flex; flex-direction:column; gap:5px; }
        .mind-rank-list { gap:2px; }
        .mind-rank-row {
          display:grid;
          grid-template-columns:minmax(0, 1fr) minmax(120px, 1fr) 84px;
          align-items:center;
          gap:10px;
          padding:7px 0;
          color:var(--text);
          text-decoration:none;
          border-bottom:1px solid var(--surface0);
        }
        .mind-rank-row:last-child { border-bottom:none; }
        .mind-rank-row:hover .mind-rank-label { color:var(--accent); }
        .mind-rank-label {
          min-width:0;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
        .mind-rank-track {
          min-width:0;
          height:8px;
          background:var(--surface0);
          border-radius:999px;
          overflow:hidden;
        }
        .mind-rank-fill {
          display:block;
          height:100%;
          border-radius:999px;
        }
        .mind-rank-meta {
          display:flex;
          flex-direction:column;
          align-items:flex-end;
          gap:1px;
          text-align:right;
          font-variant-numeric:tabular-nums;
          line-height:1.15;
        }
        .mind-rank-meta strong { color:var(--text); font-size:11px; font-weight:600; }
        .mind-rank-meta span { color:var(--subtext0); font-size:10px; }
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
    return `<a href="#" class="mind-rank-row mind-godlink" data-id="${escapeHtml(x.id)}"><span class="mind-rank-label" title="${escapeHtml(x.label)}">${escapeHtml(x.label)}</span><span class="mind-rank-track"><span class="mind-rank-fill" style="width:${pct.toFixed(1)}%;background:#fab387"></span></span><span class="mind-rank-meta"><strong>${x.degree}</strong><span>connections</span></span></a>`;
  }

  function contributorRow(label, value, max) {
    const pct = (value / max) * 100;
    return `<div class="mind-rank-row"><span class="mind-rank-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="mind-rank-track"><span class="mind-rank-fill" style="width:${pct.toFixed(1)}%;background:${cliColor(label)}"></span></span><span class="mind-rank-meta"><strong>${value}</strong><span>entries</span></span></div>`;
  }

  function communityRow(cid, c, maxSize) {
    const cohesionPct = Math.round((c.cohesion || 0) * 100);
    const pct = ((c.size || 0) / Math.max(1, maxSize)) * 100;
    return `<a href="#" class="mind-rank-row" data-cid="${escapeHtml(cid)}"><span class="mind-rank-label" title="${escapeHtml(c.label)}">#${cid} ${escapeHtml(c.label)}</span><span class="mind-rank-track"><span class="mind-rank-fill" style="width:${pct.toFixed(1)}%;background:${communityColor(parseInt(cid, 10))}"></span></span><span class="mind-rank-meta"><strong>${c.size} nodes</strong><span>${cohesionPct}% cohesion</span></span></a>`;
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
      <div style="flex:1;min-height:0;width:100%;background:var(--mantle);position:relative;">
        <div id="mindCanvasHost" style="position:absolute;inset:0;"></div>
        <div id="mindGraphLoader" class="mind-loader-overlay" style="display:none;">
          <div class="mind-spinner"></div>
          <div class="mind-loader-text">Laying out map...</div>
        </div>
      </div>`;

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

    const searchOnly = !!(state.prefs.searchOnly && matchSet && matchedCommunities.size);
    const visibleCIds = searchOnly ? cIds.filter(cid => matchedCommunities.has(cid)) : cIds;
    const nodes = visibleCIds.map(cid => {
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
    const visibleSet = new Set(visibleCIds);
    const edges = Array.from(bridgeCount.entries())
      .filter(([key]) => {
        const [a, b] = key.split('|');
        return visibleSet.has(a) && visibleSet.has(b);
      })
      .map(([key, count], i) => {
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
      <div style="flex:1;min-height:0;width:100%;background:var(--mantle);position:relative;">
        <div id="mindCanvasHost" style="position:absolute;inset:0;"></div>
        <div id="mindGraphLoader" class="mind-loader-overlay" style="display:flex;">
          <div class="mind-spinner"></div>
          <div class="mind-loader-text">Preparing graph...</div>
        </div>
      </div>`;

    // Hydrate the controls from saved prefs before the first build so we
    // don't waste a layout on the wrong cap.
    const filterEl = $('mindGraphFilter');
    const capEl = $('mindGraphCap');
    if (filterEl) filterEl.value = state.prefs.graphFilter;
    if (capEl) capEl.value = state.prefs.graphCap;
    updatePhysicsBtnLabel();

    buildNetworkAsync({ loaderText: state.prefs.graphCap === 'all' ? 'Loading full graph...' : 'Laying out graph...' });
    filterEl.addEventListener('change', () => {
      state.prefs.graphFilter = filterEl.value;
      savePrefs();
      buildNetworkAsync({ loaderText: state.prefs.graphCap === 'all' ? 'Refreshing full graph...' : 'Refreshing graph...' });
    });
    capEl.addEventListener('change', () => {
      state.prefs.graphCap = capEl.value;
      savePrefs();
      buildNetworkAsync({ loaderText: capEl.value === 'all' ? 'Loading full graph...' : 'Laying out graph...' });
    });
  }

  // Wraps buildNetwork() so the loader overlay paints before the synchronous
  // DataSet construction + vis.Network init blocks the main thread, then stays
  // visible until the first stabilization pass is done.
  function buildNetworkAsync({ focusId = null, loaderText = 'Laying out graph...' } = {}) {
    const seq = ++state.graphBuildSeq;
    showGraphLoader(loaderText);
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (seq !== state.graphBuildSeq) return;
        try {
          buildNetwork({
            seq,
            onReady: () => {
              if (seq !== state.graphBuildSeq) return;
              focusGraphNode(focusId);
              hideGraphLoader();
            },
          });
        } catch (err) {
          hideGraphLoader();
          throw err;
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
    // Drawers (verbatim user/assistant turns) get a distinctive triangleDown
    // so they're separable from concept dots and conversation hexagons.
    drawer: 'triangleDown',
  };

  function nodeSize(degree) {
    return Math.min(40, Math.max(8, 8 + Math.sqrt(degree) * 3));
  }

  function buildNetwork({ seq = state.graphBuildSeq, onReady = null } = {}) {
    const g = state.graph;
    const host = $('mindCanvasHost');
    if (!host || !g) {
      if (typeof onReady === 'function') onReady();
      return;
    }

    const filter = $('mindGraphFilter')?.value || 'all';
    const capRaw = $('mindGraphCap')?.value || '1000';
    // "all" = no cap (Everything option). Anything else parses to a node count.
    const cap = capRaw === 'all' ? Infinity : parseInt(capRaw, 10);

    let nodes = g.nodes;
    if (filter !== 'all') nodes = nodes.filter(n => n.kind === filter);
    // Search-only mode: drop everything that doesn't match. Skips the cap
    // logic entirely - matches are usually small enough to draw in full.
    if (state.prefs.searchOnly && state.search && state.matches.length) {
      const onlySet = new Set(state.matches);
      nodes = nodes.filter(n => onlySet.has(n.id));
    }

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

    const finishBuild = () => {
      if (seq !== state.graphBuildSeq) return;
      try {
        state.network.setOptions({ physics: { stabilization: { enabled: false }, enabled: state.prefs.physicsEnabled !== false } });
      } catch (_) {}
      updatePhysicsBtnLabel();
      if (typeof onReady === 'function') requestAnimationFrame(onReady);
    };
    let buildFinished = false;
    const fallbackMs = capRaw === 'all' ? 15000 : 5000;
    const fallbackTimer = setTimeout(finalizeOnce, fallbackMs);
    function finalizeOnce() {
      if (buildFinished) return;
      buildFinished = true;
      clearTimeout(fallbackTimer);
      finishBuild();
    }

    state.network.on('click', (params) => {
      if (params.nodes && params.nodes.length) {
        state.selectedNode = params.nodes[0];
        showNodeDetail(params.nodes[0]);
      }
    });
    state.network.once('stabilizationIterationsDone', finalizeOnce);
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
    const r = await fetch('/api/mind/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.status === 409) {
      const body = await r.json().catch(() => ({}));
      setStatus(`build already running (pid ${body.holderPid || '?'}, ${Math.round((body.ageMs || 0) / 1000)}s)`);
      refreshLock();
      return;
    }
    refreshLock();
  }
  async function update() {
    setStatus('starting incremental update...');
    const r = await fetch('/api/mind/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.status === 409) {
      const body = await r.json().catch(() => ({}));
      setStatus(`update already running (pid ${body.holderPid || '?'})`);
      refreshLock();
      return;
    }
    refreshLock();
  }
  async function refreshLock() {
    try {
      const r = await API('/api/mind/lock');
      const pill = document.getElementById('mindLockPill');
      if (!pill) return;
      const active = (r.build && r.build.locked) ? r.build : (r.update && r.update.locked) ? r.update : null;
      if (!active) { pill.style.display = 'none'; return; }
      pill.style.display = 'inline-flex';
      const text = document.getElementById('mindLockText');
      const ageS = Math.round((active.ageMs || 0) / 1000);
      if (text) text.textContent = `${active.op} running (pid ${active.holderPid}, ${ageS}s)`;
      pill.title = `Lock held by pid ${active.holderPid} for ${ageS}s. Right-click to clear if stuck.`;
      pill.oncontextmenu = (e) => {
        e.preventDefault();
        if (!confirm('Force-clear the build lock? This will not stop the running build.')) return;
        fetch('/api/mind/lock/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: active.op }) })
          .then(() => refreshLock());
      };
    } catch (_) { /* ignore */ }
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
  function parseWakeupText(text) {
    const decoded = decodeHtmlEntities(text || '');
    const lines = decoded.split(/\r?\n/);
    const sections = new Map();
    let current = null;
    for (const raw of lines) {
      if (/^##\s+/.test(raw)) {
        current = raw.replace(/^##\s+/, '').trim();
        sections.set(current, []);
        continue;
      }
      if (!current) continue;
      sections.get(current).push(raw);
    }

    const identity = {};
    const l0Lines = sections.get('L0 - IDENTITY') || [];
    const l1Title = Array.from(sections.keys()).find(k => k.startsWith('L1 -')) || 'L1';
    const storyLines = (sections.get(l1Title) || []).map(line => line.trim()).filter(Boolean);
    let preamble = [];
    let inPreamble = false;

    for (const raw of l0Lines) {
      const line = raw || '';
      if (!line.trim()) continue;
      if (line.trim() === 'repo_preamble:') {
        inPreamble = true;
        continue;
      }
      if (inPreamble) {
        preamble.push(line.trim());
        continue;
      }
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) identity[key] = value;
    }

    return {
      raw: decoded,
      identity,
      preamble: preamble.join('\n').trim(),
      l1Title,
      storyLines,
    };
  }
  function renderWakeupStoryLine(line) {
    const clean = (line || '').trim();
    if (!clean) return '';
    if (/:$/.test(clean) && !clean.startsWith('- ') && !clean.startsWith('[') && !clean.startsWith('->') && !clean.startsWith('~>') && !clean.startsWith('?>')) {
      return `<div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-top:4px;">${escapeHtml(clean.slice(0, -1))}</div>`;
    }
    const text = clean.startsWith('- ') ? clean.slice(2) : clean;
    const bg = clean.startsWith('->') || clean.startsWith('~>') || clean.startsWith('?>') ? 'var(--surface0)' : 'var(--base)';
    return `<div style="padding:8px 10px;background:${bg};border:1px solid var(--surface0);border-radius:6px;font-size:11px;color:var(--text);line-height:1.5;overflow-wrap:anywhere;">${escapeHtml(text)}</div>`;
  }
  function renderWakeupPreview(data) {
    const parsed = parseWakeupText(data.text || '');
    const identityRows = [
      ['Repo', parsed.identity.active_repo || '(none selected)'],
      ['Path', parsed.identity.active_repo_path || '(not available)'],
      ['Space', parsed.identity.mind_space || '(not available)'],
    ];
    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;">
        <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;"><div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">Mode</div><div style="font-size:12px;color:var(--text);">${data.queryAware ? 'Task-aware' : 'General context'}</div></div>
        <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;"><div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">Size</div><div style="font-size:12px;color:var(--text);">~${data.estTokens || 0} tokens</div></div>
        <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;"><div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">Identity layer</div><div style="font-size:12px;color:var(--text);">${data.layers?.l0Chars || 0} chars</div></div>
        <div style="padding:10px 12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;"><div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:4px;">Memory layer</div><div style="font-size:12px;color:var(--text);">${data.layers?.l1Chars || 0} chars</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;">
        <div style="padding:12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:8px;">Workspace identity</div>
          <div style="display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;font-size:11px;line-height:1.5;">
            ${identityRows.map(([label, value]) => `<div style="color:var(--subtext0);">${escapeHtml(label)}</div><div style="color:var(--text);overflow-wrap:anywhere;">${escapeHtml(value)}</div>`).join('')}
          </div>
        </div>
        <div style="padding:12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:8px;">Repo instructions excerpt</div>
          <div style="font-size:11px;color:var(--text);line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;">${escapeHtml(parsed.preamble || 'No repo preamble found.')}</div>
        </div>
      </div>
      <div style="padding:12px;background:var(--base);border:1px solid var(--surface0);border-radius:6px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--subtext0);margin-bottom:8px;">${escapeHtml(parsed.l1Title.replace(/^L1 -\s*/, ''))}</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${parsed.storyLines.length ? parsed.storyLines.map(renderWakeupStoryLine).join('') : '<div style="font-size:11px;color:var(--subtext0);font-style:italic;">No memory summary available yet.</div>'}
        </div>
      </div>
      <details style="background:var(--base);border:1px solid var(--surface0);border-radius:6px;padding:10px 12px;">
        <summary style="cursor:pointer;font-size:11px;color:var(--subtext0);">Raw prompt text</summary>
        <pre style="margin:10px 0 0;background:var(--mantle);padding:12px;border-radius:6px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;color:var(--text);border:1px solid var(--surface0);">${escapeHtml(parsed.raw || '(empty)')}</pre>
      </details>`;
  }
  // Decode HTML entities that may have been written into labels by older
  // builds (sanitizeLabel used to HTML-escape at write time, which double-
  // escaped at render). Decode iteratively so `&amp;quot;` becomes `"`.
  function decodeHtmlEntities(s) {
    if (typeof s !== 'string') return '';
    let prev = null; let out = s;
    for (let i = 0; i < 3 && out !== prev; i++) {
      prev = out;
      out = out.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
    }
    return out;
  }
  function escapeHtml(s) {
    if (typeof s !== 'string') s = String(s ?? '');
    s = decodeHtmlEntities(s);
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

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

  window.MindUI = { onActivate, setView, build, update, toggleWatch, askAbout, purgeNode, closeDetail, fitGraph, togglePhysics, clearSearch, toggleSearchOnly,
    refreshLock, refreshQuality,
    _wakeupRefresh: refreshWakeupOutput,
    _queryRun: runQueryFromUi,
    _impactRun: runImpact,
    _flowRun: runFlow,
    _symbolRun: runSymbol,
    _smartRun: runSmart,
    _embedAll: embedAll,
    _wakeupOpen: () => { state.view = 'dashboard'; renderWakeup(); },
    _healthCheck: async () => {
      const el = document.getElementById('mindDiagOut');
      if (!el) return;
      el.textContent = 'checking...';
      try {
        const h = await API('/api/mind/health');
        const e = h.embeddings || {}; const v = h.vectors || {};
        el.textContent = `embed:${e.ok ? 'ok' : 'down'}(${e.provider || '?'},${e.dimensions || '?'}d) · vectors:${v.count || 0}/${v.dim || 0}d`;
      } catch (err) { el.textContent = 'error: ' + (err.message || err); }
    },
  };
})();
