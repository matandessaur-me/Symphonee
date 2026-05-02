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
  const DEFAULT_PREFS = { graphCap: '200', graphFilter: 'all', physicsEnabled: false, searchOnly: false, graphMode: '3d' };
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
    graphSettled: false,   // true after the current vis-network stabilization pass
    ws: null,
    search: '',            // current search term (lowercased, trimmed)
    matches: [],           // ids of nodes matching state.search, ordered
    matchIndex: 0,         // current cursor for Enter-cycling
    prefs: loadPrefs(),    // persisted graph cap/filter/physics
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  function onActivate() {
    state.tabActive = true;
    refreshStatus();
    loadGraph().then(render);
    if (!state.ws) connectWS();
    bindSearchInput();
    updateSearchOnlyBtn();
    refreshLock();
    refreshQuality();
    // Resume physics on re-entry only if the user had it on. Frozen graphs
    // stay frozen - we don't want to undo their preference.
    if (state.network && state.prefs.physicsEnabled !== false && state.graphSettled) {
      try { state.network.setOptions({ physics: { enabled: true } }); } catch (_) {}
    }
  }

  // Called by switchTab() when the user leaves the Mind tab. We fully tear
  // down the network and drop the in-memory graph payload. Memory was the
  // visible problem (946 MB Electron RSS in the screenshot) - the vis
  // DataSets, the raw graph JSON, and the canvas backing store add up to
  // hundreds of MB on a 1k-node graph. Re-fetching on activate is cheap.
  function onDeactivate() {
    state.tabActive = false;
    teardownNetwork();
    state.graph = null;
    state.matches = [];
    // Reset the gate so re-entering the Mind tab shows the entry button
    // again instead of immediately laying out 6k+ nodes.
    state.mindmapLoaded = false;
    // Close the node-detail sidebar so it doesn't reappear stale next
    // time the user opens Mind.
    try { const d = document.getElementById('mindDetail'); if (d) { d.style.display = 'none'; } state.selectedNode = null; } catch (_) {}
  }

  // Pause + tear down when the OS window is hidden. Even with physics off
  // vis-network keeps a rAF loop alive for hover/redraw and Electron does
  // not throttle backgrounded windows the way Chrome throttles tabs.
  if (typeof document !== 'undefined' && !state.visibilityBound) {
    state.visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      const hidden = document.visibilityState === 'hidden';
      if (hidden) {
        if (state.network) {
          try { state.network.setOptions({ autoResize: false, physics: { enabled: false } }); } catch (_) {}
        }
      } else if (state.tabActive && state.network) {
        try {
          state.network.setOptions({
            autoResize: true,
            physics: { enabled: state.prefs.physicsEnabled !== false && state.graphSettled },
          });
        } catch (_) {}
      }
    });
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
    // Search no longer fires on every keystroke - rebuilding the 3D
    // graph mid-typing was redrawing the network on every character.
    // Now you commit a search via Enter or the Go button. Arrow keys
    // still cycle through hits when a search is already active.
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (state.search && state.matches.length) {
          cycleMatch(ev.shiftKey ? -1 : 1);
        } else {
          applySearch(input.value);
        }
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        clearSearch();
      } else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && state.matches.length) {
        ev.preventDefault();
        cycleMatch(ev.key === 'ArrowRight' ? 1 : -1);
      }
    });
  }
  function runSearch() {
    const input = $('mindSearchInput');
    if (!input) return;
    applySearch(input.value);
  }

  function toggleSearchOnly() {
    state.prefs.searchOnly = !state.prefs.searchOnly;
    savePrefs();
    updateSearchOnlyBtn();
    // Re-render the active view so the new mode lands. Same dispatch as
    // applySearch(): graph/map paint in place, others rebuild.
    if (state.view === 'graph') paintGraphSearch();
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
    // Re-render the active view. Graph + mindmap views prefer in-place
    // re-paint (paintGraphSearch -> buildNetworkAsync) so we don't blow
    // away the canvas DOM and accidentally resurface the 'Enter Mind Map'
    // gate. Other views can rebuild — they're cheap.
    if (state.view === 'graph' || state.view === 'mindmap') paintGraphSearch();
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
      const warnings = payload.result && payload.result.validationWarningCount;
      setStatus(warnings ? `build complete - skipped ${warnings} invalid item(s)` : 'build complete - reloading');
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
    // Pre-fetch cached graph layouts in parallel with whatever the user does
    // next. If a layout is cached AND the node set hasn't changed, the
    // simulator is skipped entirely (instant render, no GPU pin).
    state.layoutCache = { '2d': null, '3d': null, hash: null };
    if (state.graph) {
      // Layout-algo version. Bump when the pre-positioning or force-tuning
      // changes meaningfully so old cached positions don't lock the user
      // into a stale (bad) layout. Hash includes this version so a mismatch
      // forces fresh layout + cache rewrite.
      const LAYOUT_VERSION = 'v3-2d-fib-spiral-strong-charge';
      state.layoutCache.hash = computeNodeHash(state.graph.nodes) + ':' + LAYOUT_VERSION;
      try {
        const [c2, c3] = await Promise.all([
          API('/api/mind/layout?mode=2d').catch(() => null),
          API('/api/mind/layout?mode=3d').catch(() => null),
        ]);
        if (c2 && c2.cached && c2.nodeHash === state.layoutCache.hash) state.layoutCache['2d'] = c2.positions;
        if (c3 && c3.cached && c3.nodeHash === state.layoutCache.hash) state.layoutCache['3d'] = c3.positions;
      } catch (_) {}
    }
    return state.graph;
  }

  // Cheap stable hash over node ids — used to invalidate the layout cache
  // when the node set changes (build added or removed nodes). We sort + join
  // and SHA-trunc; if the same set of ids comes back the hash matches and
  // the cached positions are reused.
  function computeNodeHash(nodes) {
    const ids = nodes.map(n => n.id).sort();
    let h = 5381;
    for (const id of ids) {
      for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
    }
    return `${ids.length}_${(h >>> 0).toString(16)}`;
  }

  // Save the current force-graph positions back to the server. Called from
  // onEngineStop. Best-effort, no UI feedback — if the save fails, next
  // load just re-runs the layout.
  function persistLayout(mode, fgInstance) {
    try {
      if (!state.layoutCache || !state.layoutCache.hash) return;
      const data = fgInstance.graphData ? fgInstance.graphData() : null;
      if (!data || !Array.isArray(data.nodes) || !data.nodes.length) return;
      const positions = {};
      for (const n of data.nodes) {
        if (n.id == null) continue;
        if (mode === '3d') positions[n.id] = [n.x || 0, n.y || 0, n.z || 0];
        else positions[n.id] = [n.x || 0, n.y || 0];
      }
      fetch('/api/mind/layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, nodeHash: state.layoutCache.hash, positions }),
      }).catch(() => {});
      state.layoutCache[mode] = positions;
    } catch (_) {}
  }

  async function refreshStatus() {
    const s = await API('/api/mind/stats');
    if (!s.stats) {
      setStatus(`${s.space || 'space'}: empty`);
      return;
    }
    const age = formatRelativeMs(Date.now() - new Date(s.stats.lastBuildAt).getTime());
    setStatus(`${s.space}: ${s.stats.nodes} nodes, ${s.stats.edges} edges, ${s.stats.communities} communities, ${age}`);
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
    // Close any open node detail when switching Mind sub-tabs - the
    // sidebar context is tied to the previous view's selection.
    try { closeDetail(); } catch (_) {}
    render();
  }

  function render() {
    teardownNetwork();
    // Mind map view always full-bleed (its own ribbon + body manage padding).
    const main = $('mindMain');
    if (main) {
      const fullBleed = (state.view === 'mindmap');
      main.style.padding = fullBleed ? '0' : '14px 18px';
      main.style.overflow = fullBleed ? 'hidden' : '';
      main.style.overflowY = fullBleed ? 'hidden' : 'auto';
      main.style.overflowX = 'hidden';
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

  // ── Mind map view (Graph only) ──────────────────────────────────────────
  // The Map (community super-nodes) view was dropped - users found the Graph
  // told the same story more clearly. renderMindmap() now just renders the
  // graph directly into #mindMain, no sub-ribbon needed.
  function renderMindmap() {
    state.mindmapMode = 'graph';
    renderGraph();
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
      const ok = await copyToClipboard(d.mermaid);
      setStatus(ok ? 'mermaid source copied' : 'copy failed - try selecting and copying manually');
    } catch (e) {
      setStatus('mermaid error: ' + (e.message || e));
    }
  }

  // Reliable copy with fallback for Electron contexts where the async
  // clipboard API is blocked. Returns true on success.
  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through to legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  // ── Smart search (hybrid BM25 + dense via RRF) ──────────────────────────
  async function renderSmart() {
    const main = $('mindMain');
    if (!main) return;
    const last = state.smart || {};
    main.innerHTML = `
      <div class="mind-smart">
        <header class="mind-smart-head">
          <div>
            <div class="mind-smart-title">Search</div>
            <div class="mind-smart-sub">
              Hybrid BM25 and semantic lookup across code, notes, docs, and prior AI sessions.
            </div>
          </div>
          <button class="mindmap-ribbon-btn" onclick="MindUI._embedAll()" title="Rebuild semantic vectors for the whole graph">Embed graph</button>
        </header>

        <div class="mind-smart-grid">
          <section class="mind-smart-card mind-smart-card-search">
            <div class="mind-smart-card-title">Ask the brain</div>
            <div class="mind-smart-form">
              <input id="mindSmartQ" type="text" placeholder="Ask anything: auth flow, orchestrator mount, tsconfig aliases..." autofocus value="${escapeHtml(last.q || '')}">
              <input id="mindSmartK" type="number" min="3" max="50" value="${last.k || 12}" title="Result count">
              <button class="mindmap-ribbon-btn primary" onclick="MindUI._smartRun()">Search</button>
            </div>
            <div id="mindSmartHealth" class="mind-smart-health"></div>
          </section>

          <section class="mind-smart-card mind-smart-card-help">
            <div class="mind-smart-card-title">Ranking signals</div>
            <div class="mind-smart-help-grid">
              <div><b>BM25</b><span>Literal token matches.</span></div>
              <div><b>Dense</b><span>Semantic similarity from embeddings.</span></div>
              <div><b>Fusion</b><span>Best overlap rises to the top.</span></div>
            </div>
          </section>

          <section class="mind-smart-card mind-smart-results">
            <div class="mind-smart-card-title">Results</div>
            <div id="mindSmartOut" class="mind-smart-out">
              <div class="mind-smart-empty">Run a search to see ranked context cards here.</div>
            </div>
          </section>
        </div>
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
        `<span style="color:var(--subtext0);">semantic provider not configured</span>`;
      const vOk = v.count > 0 ? `<span style="color:var(--green);">${v.count} vectors indexed (${v.dim}d, ${escapeHtml(v.provider || '')})</span>` :
        '<span style="color:var(--yellow);">no vectors yet</span>';
      el.innerHTML = `${eOk} · ${vOk}`;
    } catch (_) { /* ignore */ }
  }

  async function runSmart() {
    const q = ($('mindSmartQ') && $('mindSmartQ').value || '').trim();
    const k = parseInt(($('mindSmartK') && $('mindSmartK').value) || '12', 10);
    state.smart = { q, k };
    const out = $('mindSmartOut');
    if (!out) return;
    if (!q) { out.innerHTML = '<div class="mind-smart-empty">Enter a query to search the graph.</div>'; return; }
    out.innerHTML = '<div class="mind-smart-empty">Searching...</div>';
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
          <a href="#" class="mind-smart-link" data-id="${escapeHtml(id)}">
            <div class="mind-smart-link-row">
              <div class="mind-smart-link-main">
                <span class="mind-smart-rank">#${rank + 1}</span>
                <span class="mind-smart-label">${label}</span> ${kind}
              </div>
              <div class="mind-smart-signal">${both}</div>
            </div>
          </a>`;
      }).join('') || '<div class="mind-smart-empty">No matches.</div>';
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
  // ── Impact view (list-first) ────────────────────────────────────────────
  // Two columns: searchable Symbols rail on the left, selected-symbol detail
  // panel on the right. No more "type the exact symbol name" inputs - the
  // user sees the full list, filters with a search box, clicks to inspect.
  // Entrypoints are exposed as quick chips at the top of the rail. The raw
  // /api/mind/impact, /flow, /symbol, /symbols, /entrypoints, /circular
  // endpoints are unchanged - the AI surface keeps everything, we just
  // strip the manual-input UI from the human surface.
  // File-first Impact view. The symbol-level call graph is approximate
  // (regex-based) so we show files first - the file-import graph is
  // comprehensive and reliable. Symbols appear as a sub-list when a file
  // is selected, with a clear notice when the call graph is sparse.
  let _impactFiles = [];
  let _impactSelectedPath = null;

  async function renderImpact() {
    const main = $('mindMain');
    if (!main) return;
    main.innerHTML = `
      <div class="mind-impact">
        <div class="mind-impact-head">
          <div>
            <div class="mind-impact-title">Impact</div>
            <div class="mind-impact-sub">
              <b>What breaks if I delete or rename this file?</b>
              Pick a file to see its imports, dependents, and a one-click blast radius.
            </div>
          </div>
        </div>
        <div class="mind-impact-body">
          <aside class="mind-impact-rail">
            <div class="mind-impact-rail-search">
              <input id="mindImpactFilter" type="text" placeholder="filter files..." autocomplete="off" spellcheck="false">
              <span id="mindImpactCount" class="mind-impact-count">…</span>
            </div>
            <div id="mindCircularPanel"></div>
            <div id="mindImpactList" class="mind-impact-list">
              <div style="padding:14px;color:var(--subtext0);font-size:11px;">Loading files…</div>
            </div>
          </aside>
          <section class="mind-impact-detail" id="mindImpactDetail">
            <div class="mind-impact-empty">
              <div style="font-size:13px;color:var(--text);margin-bottom:6px;">No file selected</div>
              <div style="font-size:11px;color:var(--subtext0);">Pick a file on the left. Files are sorted by how many other files reference them - the most "load-bearing" ones at the top.</div>
            </div>
          </section>
        </div>
      </div>`;

    Promise.all([
      fetch('/api/mind/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json()).catch(() => ({ files: [] })),
      fetch('/api/mind/circular', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json()).catch(() => ({ cycles: [] })),
    ]).then(([fileData, cycData]) => {
      _impactFiles = (fileData.files || []);
      renderImpactList(_impactFiles);
      renderImpactCircular(cycData);
    });

    const filter = $('mindImpactFilter');
    if (filter) {
      filter.addEventListener('input', () => {
        const q = filter.value.trim().toLowerCase();
        const filtered = q
          ? _impactFiles.filter(f => (f.path || '').toLowerCase().includes(q))
          : _impactFiles;
        renderImpactList(filtered);
      });
    }
  }

  function renderImpactList(files) {
    const list = $('mindImpactList');
    const count = $('mindImpactCount');
    if (count) count.textContent = files.length + (files.length === _impactFiles.length ? '' : '/' + _impactFiles.length);
    if (!list) return;
    if (!files.length) {
      list.innerHTML = '<div style="padding:14px;color:var(--subtext0);font-size:11px;">No matches.</div>';
      return;
    }
    list.innerHTML = files.slice(0, 800).map(f => {
      const total = f.dependentsCount + f.importsCount;
      const heat = total > 50 ? 'hot' : total > 10 ? 'warm' : '';
      return `
        <button class="mind-impact-row${_impactSelectedPath === f.path ? ' active' : ''}" data-path="${escapeHtml(f.path)}">
          <span class="mind-impact-row-name">${escapeHtml(basenameOf(f.path))}</span>
          <span class="mind-impact-row-file">${escapeHtml(f.path)}</span>
          <span class="mind-impact-row-meta">
            <span class="mind-impact-pip ${heat}" title="${f.dependentsCount} files import this · ${f.importsCount} imports">
              ←${f.dependentsCount} →${f.importsCount}
            </span>
          </span>
        </button>`;
    }).join('');
    list.querySelectorAll('.mind-impact-row').forEach(btn => {
      btn.addEventListener('click', () => selectImpactFile(btn.dataset.path));
    });
  }

  function basenameOf(p) {
    if (!p) return '';
    const parts = String(p).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || p;
  }

  function renderImpactCircular(data) {
    const panel = $('mindCircularPanel');
    if (!panel) return;
    if (!data || !data.count) { panel.innerHTML = ''; return; }
    const cycles = (data.cycles || []).slice(0, 3);
    panel.innerHTML = `
      <details class="mind-impact-cycle-card">
        <summary>
          <span>
            <span class="mind-impact-cycle-count">${data.count}</span>
            circular dependenc${data.count === 1 ? 'y' : 'ies'}
          </span>
          <span class="mind-impact-cycle-hint">View</span>
        </summary>
        <div class="mind-impact-cycle-list">
          ${cycles.map(cycle => `
            <div class="mind-impact-cycle-path">
              ${(cycle || []).map(p => `<span title="${escapeHtml(p)}">${escapeHtml(basenameOf(p))}</span>`).join('<b>to</b>')}
            </div>`).join('')}
        </div>
      </details>`;
  }

  async function selectImpactFile(path) {
    _impactSelectedPath = path;
    document.querySelectorAll('.mind-impact-row').forEach(r => r.classList.toggle('active', r.dataset.path === path));
    const detail = $('mindImpactDetail');
    if (!detail) return;
    detail.innerHTML = `
      <div class="mind-impact-detail-head">
        <div>
          <div class="mind-impact-detail-name">${escapeHtml(basenameOf(path))}</div>
          <div class="mind-impact-detail-file">${escapeHtml(path)}</div>
        </div>
        <div class="mind-impact-actions">
          <button class="mindmap-ribbon-btn primary" id="mindImpactBlastBtn">Blast radius</button>
        </div>
      </div>
      <div class="mind-impact-cards">
        <div class="mind-impact-card" id="mindImpactDeps">
          <div class="mind-impact-card-title">Imported by <span id="mindImpactDepsCount" style="color:var(--text);font-weight:normal;"></span></div>
          <div class="mind-impact-card-body" id="mindImpactDepsBody">Loading…</div>
        </div>
        <div class="mind-impact-card" id="mindImpactImports">
          <div class="mind-impact-card-title">Imports <span id="mindImpactImpCount" style="color:var(--text);font-weight:normal;"></span></div>
          <div class="mind-impact-card-body" id="mindImpactImpBody">Loading…</div>
        </div>
      </div>
      <div class="mind-impact-card" id="mindImpactSyms">
        <div class="mind-impact-card-title">Symbols in this file <span id="mindImpactSymsCount" style="color:var(--text);font-weight:normal;"></span></div>
        <div class="mind-impact-card-body" id="mindImpactSymsBody">Loading…</div>
      </div>
      <div class="mind-impact-card mind-impact-card-wide" id="mindImpactBlast" style="display:none;">
        <div class="mind-impact-card-title">Blast radius (transitive dependents)</div>
        <div class="mind-impact-card-body"></div>
      </div>`;

    try {
      const r = await fetch('/api/mind/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
      const data = await r.json();
      if (data.error) { document.getElementById('mindImpactDepsBody').textContent = data.error; return; }

      const depsBody = document.getElementById('mindImpactDepsBody');
      const depsCount = document.getElementById('mindImpactDepsCount');
      if (depsCount) depsCount.textContent = '· ' + (data.dependents || []).length;
      depsBody.innerHTML = (data.dependents && data.dependents.length)
        ? data.dependents.map(d => `
          <button class="mind-impact-link" data-path="${escapeHtml(d.path)}">
            ← <span class="mind-impact-call-name">${escapeHtml(basenameOf(d.path))}</span>
            <span class="mind-impact-call-file">${escapeHtml(d.path)}</span>
          </button>`).join('')
        : '<span style="color:var(--subtext0);font-size:11px;">Nothing imports this file. It may be an entrypoint, an orphan, or a leaf.</span>';

      const impBody = document.getElementById('mindImpactImpBody');
      const impCount = document.getElementById('mindImpactImpCount');
      if (impCount) impCount.textContent = '· ' + (data.imports || []).length;
      impBody.innerHTML = (data.imports && data.imports.length)
        ? data.imports.map(d => `
          <button class="mind-impact-link${d.external ? ' external' : ''}" data-path="${escapeHtml(d.path)}" ${d.external ? 'disabled' : ''}>
            → <span class="mind-impact-call-name">${escapeHtml(d.external ? d.path.replace(/^ext_/, '') : basenameOf(d.path))}</span>
            <span class="mind-impact-call-file">${escapeHtml(d.external ? '(external)' : d.path)}</span>
          </button>`).join('')
        : '<span style="color:var(--subtext0);font-size:11px;">No imports detected in this file.</span>';

      const symsBody = document.getElementById('mindImpactSymsBody');
      const symsCount = document.getElementById('mindImpactSymsCount');
      if (symsCount) symsCount.textContent = '· ' + (data.symbols || []).length;
      symsBody.innerHTML = (data.symbols && data.symbols.length)
        ? data.symbols.slice(0, 50).map(s => `
          <div class="mind-impact-call">
            <span class="mind-impact-call-arrow">·</span>
            <span class="mind-impact-call-name">${escapeHtml(s.name)}</span>
            <span class="mind-impact-call-file">${s.line ? 'line ' + s.line : ''}</span>
          </div>`).join('')
        : '<span style="color:var(--subtext0);font-size:11px;">No symbols extracted from this file. Symphonee\'s extractor recognizes top-level functions, classes and methods - declaration patterns inside functions are not picked up.</span>';

      // Wire click-to-navigate for imports and dependents links.
      detail.querySelectorAll('.mind-impact-link').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          const target = btn.dataset.path;
          // Find in our cached list and select.
          if (_impactFiles.find(f => f.path === target)) selectImpactFile(target);
        });
      });

      const blastBtn = document.getElementById('mindImpactBlastBtn');
      if (blastBtn) blastBtn.onclick = () => runImpactFileBlast(path);
    } catch (e) {
      document.getElementById('mindImpactDepsBody').textContent = 'error: ' + (e.message || e);
    }
  }

  // File-level blast radius via the existing /api/mind/impact - it accepts
  // file paths as the target and walks reverse 'imports' edges.
  async function runImpactFileBlast(path) {
    const card = document.getElementById('mindImpactBlast');
    if (!card) return;
    card.style.display = 'block';
    const body = card.querySelector('.mind-impact-card-body');
    if (body) body.innerHTML = '<span style="color:var(--subtext0);font-size:11px;">computing…</span>';
    try {
      const r = await fetch('/api/mind/impact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: path, depth: 4 }) });
      const data = await r.json();
      if (data.error) { body.textContent = data.error; return; }
      const colors = ['#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#94e2d5', '#74c7ec'];
      const hops = Object.keys(data.filesByDepth || {}).map(hop => {
        const c = colors[(parseInt(hop, 10) - 1) % colors.length];
        const files = data.filesByDepth[hop] || [];
        return `
          <div class="mind-impact-hop">
            <div class="mind-impact-hop-title" style="color:${c};">Hop ${hop} · ${files.length} file${files.length === 1 ? '' : 's'}</div>
            ${files.map(f => `<div class="mind-impact-hop-file" style="border-left-color:${c};">${escapeHtml(f)}</div>`).join('')}
          </div>`;
      }).join('');
      body.innerHTML = `
        <div style="font-size:11px;color:var(--subtext0);margin-bottom:8px;">${data.totalFiles} file${data.totalFiles === 1 ? '' : 's'} would break if you delete or rename <b style="color:var(--text);">${escapeHtml(basenameOf(path))}</b>${data.truncated ? ' (truncated)' : ''}</div>
        ${hops || '<span style="color:var(--green);font-size:11px;">No files depend on this. Safe to delete or rename.</span>'}`;
    } catch (e) { body.textContent = 'error: ' + (e.message || e); }
  }

  // ── Knowledge view (Phase 4 placeholder; populated when artifacts ship) ─
  async function renderKnowledge() {
    const main = $('mindMain');
    if (!main) return;
    main.innerHTML = `
      <div class="mind-knowledge">
        <header class="mind-knowledge-header">
          <h2 class="mind-knowledge-title">Project knowledge</h2>
          <p class="mind-knowledge-lead">
            Tell the AI which non-code files matter most in your project so it consults them before answering.
          </p>
        </header>
        <div class="mind-knowledge-info">
          <div class="mind-knowledge-info-item">
            <div class="mind-knowledge-info-icon" style="color:var(--accent);">i</div>
            <div>
              <div class="mind-knowledge-info-title">What is an "artifact"?</div>
              <div class="mind-knowledge-info-body">
                A pointer to a non-code file or folder that holds project-wide knowledge - your database schema, an
                OpenAPI spec, architecture decision records, a domain glossary, deployment manifests. The AI can <i>read</i>
                any file already, but artifacts tell it <b style="color:var(--text);">when to consult what</b>: "before writing migrations, look at
                the schema." Each artifact has a name, a path, and a one-sentence description.
              </div>
            </div>
          </div>
          <div class="mind-knowledge-info-item">
            <div class="mind-knowledge-info-icon" style="color:var(--green);">+</div>
            <div>
              <div class="mind-knowledge-info-title">Why so few suggested?</div>
              <div class="mind-knowledge-info-body">
                Mind only suggests files at <i>conventional</i> locations (<code>schema.sql</code>, <code>openapi.yaml</code>, <code>docs/adr/</code>, etc).
                Anything else - a custom internal wiki, a Notion export, a generated TS types file - has to be added manually
                because no convention covers it. You're not missing anything; the list will grow as you add the things <i>you</i> consider important.
              </div>
            </div>
          </div>
          <div class="mind-knowledge-info-item">
            <div class="mind-knowledge-info-icon" style="color:var(--mauve);">⌘</div>
            <div>
              <div class="mind-knowledge-info-title">Scope</div>
              <div class="mind-knowledge-info-body">
                Mind is global - it ingests every repo Symphonee knows about - so artifacts are scanned across <b style="color:var(--text);">all
                repos</b>, grouped below. Each repo has its own <code>.symphonee/context-artifacts.json</code>.
              </div>
            </div>
          </div>
        </div>
        <div id="mindKnowledgeList">
          <div class="mind-knowledge-loading">Loading artifacts across all repos…</div>
        </div>
      </div>`;
    try {
      const [listRes, suggestRes] = await Promise.all([
        fetch('/api/mind/artifacts/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'all' }) }).then(r => r.json()).catch(() => ({ groups: [] })),
        fetch('/api/mind/artifacts/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'all' }) }).then(r => r.json()).catch(() => ({ groups: [] })),
      ]);

      const list = $('mindKnowledgeList');
      if (!list) return;

      const declaredGroups = listRes.groups || [];
      const suggestGroups = suggestRes.groups || [];
      // Merge by repo name
      const byRepo = new Map();
      for (const g of declaredGroups) byRepo.set(g.repo, { repo: g.repo, repoPath: g.repoPath, declared: g.artifacts || [], suggested: [] });
      for (const g of suggestGroups) {
        const slot = byRepo.get(g.repo) || { repo: g.repo, repoPath: g.repoPath, declared: [], suggested: [] };
        const existingNames = new Set(slot.declared.map(a => a.name));
        slot.suggested = (g.suggestions || []).filter(s => !existingNames.has(s.name));
        byRepo.set(g.repo, slot);
      }
      const groups = Array.from(byRepo.values());
      if (!groups.length) {
        list.innerHTML = '<div class="mind-knowledge-empty">No repos configured. Add repos in Symphonee settings to scan for artifacts.</div>';
        return;
      }

      _knowledgeSuggestionsByRepo = {};
      list.innerHTML = groups.map(g => renderKnowledgeRepoCard(g)).join('');
      // Stash suggestion arrays so artifactsCreate(repo) can resolve them
      for (const g of groups) _knowledgeSuggestionsByRepo[g.repo] = g.suggested;
      list.querySelectorAll('[data-action="create-artifacts"]').forEach(btn => {
        btn.addEventListener('click', () => artifactsCreate(btn.dataset.repo));
      });
    } catch (e) {
      const list = $('mindKnowledgeList');
      if (list) list.innerHTML = `<div class="mind-knowledge-empty">Error loading artifacts: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  let _knowledgeSuggestionsByRepo = {};

  function renderKnowledgeRepoCard(g) {
    const declared = g.declared || [];
    const suggested = g.suggested || [];
    const declaredHtml = declared.length ? `
      <div class="mind-knowledge-section-title">Declared (${declared.length})</div>
      ${declared.map(a => `
        <article class="mind-artifact-card">
          <header class="mind-artifact-head">
            <span class="mind-artifact-name">${escapeHtml(a.name)}</span>
            <span class="mind-artifact-status ${a.indexed ? 'indexed' : ''}">${a.indexed ? '● indexed' : '○ not indexed'}${a.fileCount ? ' · ' + a.fileCount + ' file' + (a.fileCount === 1 ? '' : 's') : ''}</span>
          </header>
          <div class="mind-artifact-path">${escapeHtml(a.path || '')}</div>
          <div class="mind-artifact-desc">${escapeHtml(a.description || '')}</div>
        </article>`).join('')}` : '';

    const suggestedHtml = suggested.length ? `
      <div class="mind-knowledge-section-title">Detected — not yet declared (${suggested.length})</div>
      <div class="mind-knowledge-suggest" data-repo="${escapeHtml(g.repo)}">
        ${suggested.map((s, i) => `
          <label class="mind-suggest-row">
            <input type="checkbox" data-idx="${i}" checked>
            <div class="mind-suggest-body">
              <div class="mind-suggest-head">
                <span class="mind-suggest-name">${escapeHtml(s.name)}</span>
                <span class="mind-suggest-path">${escapeHtml(s.path)}</span>
              </div>
              <div class="mind-suggest-desc">${escapeHtml(s.description)}</div>
            </div>
          </label>`).join('')}
      </div>
      <button class="mindmap-ribbon-btn primary mind-knowledge-create-btn" data-action="create-artifacts" data-repo="${escapeHtml(g.repo)}">
        Create context-artifacts.json with checked items
      </button>` : '';

    const emptyHtml = (!declared.length && !suggested.length) ? `
      <div class="mind-knowledge-empty">
        Nothing detected at conventional locations and nothing declared yet. Add a
        <code>.symphonee/context-artifacts.json</code> manually if this repo has
        documentation worth surfacing.
      </div>` : '';

    return `
      <section class="mind-knowledge-repo">
        <header class="mind-knowledge-repo-head">
          <div class="mind-knowledge-repo-name">${escapeHtml(g.repo)}</div>
          <div class="mind-knowledge-repo-path">${escapeHtml(g.repoPath || '')}</div>
        </header>
        ${declaredHtml}
        ${suggestedHtml}
        ${emptyHtml}
      </section>`;
  }

  async function artifactsCreate(repoName) {
    const block = document.querySelector(`.mind-knowledge-suggest[data-repo="${repoName}"]`);
    if (!block) return;
    const suggestions = _knowledgeSuggestionsByRepo[repoName] || [];
    const checks = block.querySelectorAll('input[type=checkbox]');
    const picked = [];
    checks.forEach(cb => {
      const idx = parseInt(cb.dataset.idx, 10);
      if (cb.checked && suggestions[idx]) picked.push(suggestions[idx]);
    });
    if (!picked.length) { setStatus('select at least one artifact'); return; }
    try {
      const r = await fetch('/api/mind/artifacts/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifacts: picked, repo: repoName }),
      });
      const data = await r.json();
      if (data.error) { setStatus('init: ' + data.error); return; }
      setStatus(`Created ${data.path} with ${data.count} artifact(s). Run a build to index them.`);
      renderKnowledge();
    } catch (e) { setStatus('init failed: ' + (e.message || e)); }
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
      if (n.kind === 'conversation' || (n.kind === 'drawer' && n.role === 'user')) recent.push(n);
    }
    for (const e of g.edges) confCounts[e.confidence] = (confCounts[e.confidence] || 0) + 1;
    recent.sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));

    const totalEdges = g.edges.length || 1;
    const lastBuildAt = stats.buildMs ? `${(stats.buildMs / 1000).toFixed(1)}s build` : '';
    const ageRel = g.generatedAt ? formatRelativeMs(Date.now() - new Date(g.generatedAt).getTime()) : '-';
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
          ${statCard('Last build', ageRel, '#94e2d5', lastBuildAt)}
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
            <div class="mind-card-title">Recent AI conversations</div>
            ${recent.length === 0
              ? '<div style="color:var(--subtext0);font-size:11px;font-style:italic;padding:6px;">no conversations yet - direct CLI sessions appear here after a Mind rebuild; orchestrator dispatches save automatically</div>'
              : '<div class="mind-feed">' + recent.slice(0, 12).map(convRow).join('') + '</div>'}
          </div>

          <div class="mind-card mind-card-wide">
            <div class="mind-card-title">Surprising bridges (cross-community)</div>
            <div class="mind-list">
              ${(g.surprises || []).slice(0, 8).map(s => surpriseRow(g, s)).join('') || '<div style="color:var(--subtext0);font-size:11px;font-style:italic;padding:6px;">no cross-community bridges yet</div>'}
            </div>
          </div>

          <div class="mind-card mind-card-wide">
            <div class="mind-card-title">Multi-CLI coverage</div>
            <div id="mindCliCoverageBody" style="font-size:11px;color:var(--text);">Loading…</div>
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
        .mind-feed-row .mind-type-badge { padding:1px 5px; border-radius:4px; font-size:9px; font-weight:600; text-transform:uppercase; letter-spacing:0.03em; }
        .mind-feed-row .mind-type-cli { background:var(--surface1); color:var(--subtext1); }
        .mind-feed-row .mind-type-agent { background:color-mix(in srgb, var(--accent) 20%, transparent); color:var(--accent); }
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
    refreshCliCoverage();
  }

  // Renders the multi-CLI coverage card on the Dashboard. Shows per-CLI:
  // memory file location (or - if absent), conversation count, drawer count,
  // history count, skills count. Lets the user verify the brain treats
  // every CLI symmetrically.
  async function refreshCliCoverage() {
    const el = document.getElementById('mindCliCoverageBody');
    if (!el) return;
    try {
      const r = await API('/api/mind/cli-coverage');
      const counts = r.counts || {};
      const memByRepo = r.memoryFilesByRepo || {};
      const klist = r.cliKnown || [];
      const colorOf = c => ({ claude: '#cba6f7', codex: '#94e2d5', gemini: '#89b4fa', grok: '#f38ba8', qwen: '#fab387', copilot: '#a6e3a1', cursor: '#f5c2e7', windsurf: '#74c7ec' }[c] || 'var(--text)');

      const repoNames = Object.keys(memByRepo);
      let html = `
        <div style="margin-bottom:8px;color:var(--subtext0);font-size:11px;line-height:1.5;">
          Symphonee is multi-CLI. Every supported CLI ingests symmetrically. A "—" below means the convention file is not present in that repo, NOT that the CLI is unsupported.
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead>
              <tr style="text-align:left;color:var(--subtext0);">
                <th style="padding:6px 8px;border-bottom:1px solid var(--surface0);">CLI</th>
                <th style="padding:6px 8px;border-bottom:1px solid var(--surface0);">Memory file (active repo)</th>
                <th style="padding:6px 8px;border-bottom:1px solid var(--surface0);text-align:right;">Conv</th>
                <th style="padding:6px 8px;border-bottom:1px solid var(--surface0);text-align:right;">Drawers</th>
                <th style="padding:6px 8px;border-bottom:1px solid var(--surface0);text-align:right;">History</th>
                <th style="padding:6px 8px;border-bottom:1px solid var(--surface0);text-align:right;">Skills</th>
              </tr>
            </thead>
            <tbody>`;
      const activeRepoName = repoNames[0];
      for (const cli of klist) {
        const c = counts[cli] || {};
        const memFile = memByRepo[activeRepoName] && memByRepo[activeRepoName][cli];
        html += `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--surface0) 50%,transparent);"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colorOf(cli)};margin-right:6px;"></span>${escapeHtml(cli)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--surface0) 50%,transparent);font-family:monospace;color:${memFile ? 'var(--text)' : 'var(--subtext0)'};">${memFile ? escapeHtml(memFile) : '—'}</td>
            <td style="padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--surface0) 50%,transparent);text-align:right;font-variant-numeric:tabular-nums;">${c.conversations || 0}</td>
            <td style="padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--surface0) 50%,transparent);text-align:right;font-variant-numeric:tabular-nums;">${c.drawers || 0}</td>
            <td style="padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--surface0) 50%,transparent);text-align:right;font-variant-numeric:tabular-nums;">${c.history || 0}</td>
            <td style="padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--surface0) 50%,transparent);text-align:right;font-variant-numeric:tabular-nums;">${(c.skills || 0) + (c.plugins || 0)}</td>
          </tr>`;
      }
      html += '</tbody></table></div>';
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = `<span style="color:var(--red);">error: ${escapeHtml(e.message || String(e))}</span>`;
    }
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
    const tags = (n.tags || []).filter(t => !['cli-session', 'conversation', 'drawer', 'verbatim', 'user', 'assistant', cli].includes(t)).slice(0, 3).map(t => `<span style="font-size:9px;color:var(--subtext0);">#${escapeHtml(t)}</span>`).join(' ');
    const typeBadge = n.kind === 'drawer'
      ? `<span class="mind-type-badge mind-type-cli">CLI</span>`
      : `<span class="mind-type-badge mind-type-agent">Agent</span>`;
    return `<div class="mind-feed-row" data-id="${escapeHtml(n.id)}">
      <div class="mind-feed-meta"><span class="mind-cli-badge" style="background:${color};color:#1e1e2e;">${escapeHtml(cli)}</span>${typeBadge}<span>${escapeHtml(date)}</span>${tags}</div>
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

  // ── Graph view (3d-force-graph / Three.js) ──────────────────────────────
  function renderGraph() {
    const main = $('mindMain');
    if (typeof window.ForceGraph3D === 'undefined') {
      main.innerHTML = `<div style="padding:20px;color:var(--red);">3D graph lib failed to load. Restart Symphonee.</div>`;
      return;
    }
    main.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;padding:8px 12px;border-bottom:1px solid var(--surface0);background:var(--mantle);">
        <div style="font-size:11px;color:var(--subtext0);flex:1;min-width:0;">
          Drag to pan - scroll to zoom - click any node to inspect. Color = node kind: yellow notes, teal AI exchanges, red work items, mauve plugins.
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
          <option value="200" selected title="Snappy. Hubs + their immediate neighborhood.">Light (200)</option>
          <option value="500" title="Balanced - structure visible.">Default (500)</option>
          <option value="1000" title="Long tail visible. Heavier scene.">Important (1000)</option>
          <option value="all" title="Every node. Slow layout, hairball view - search to navigate.">Everything</option>
        </select>
        <button class="tab-bar-btn" onclick="MindUI.fitGraph()" style="font-size:11px;" title="Fit graph to view">Fit</button>
        <button class="tab-bar-btn" onclick="MindUI.deselectNode()" id="mindDeselectBtn" style="font-size:11px;display:none;" title="Clear selection and show all nodes">Deselect</button>
        <button class="tab-bar-btn" onclick="MindUI.showConnected()" id="mindShowConnBtn" style="font-size:11px;display:none;" title="Frame the selected node and its neighbors in view">Show connected</button>
        <span id="mindModeSwitch" style="display:inline-flex;align-items:center;background:var(--surface0);border:1px solid var(--surface1);border-radius:4px;padding:2px;gap:2px;font-size:11px;line-height:1;" title="Toggle 2D / 3D renderer">
          <button type="button" data-mode="2d" onclick="MindUI.setGraphMode('2d')" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;font-size:11px;line-height:1;padding:3px 8px;border-radius:3px;">2D</button>
          <button type="button" data-mode="3d" onclick="MindUI.setGraphMode('3d')" style="background:transparent;border:none;color:var(--subtext0);cursor:pointer;font-size:11px;line-height:1;padding:3px 8px;border-radius:3px;">3D</button>
        </span>
      </div>
      <div style="flex:1;min-height:0;width:100%;background:var(--mantle);position:relative;">
        <div id="mindCanvasHost" style="position:absolute;inset:0;"></div>
        <button type="button" id="mindCanvasDeselect" onclick="MindUI.deselectNode()" title="Deselect (Esc)" style="position:absolute;left:14px;bottom:14px;display:none;background:var(--surface0);border:1px solid var(--surface1);border-radius:6px;color:var(--text);cursor:pointer;font-size:12px;font-weight:600;padding:8px 16px;letter-spacing:0.2px;z-index:5;box-shadow:0 2px 8px rgba(0,0,0,0.35);">Deselect</button>
        <div id="mindGraphLoader" class="mind-loader-overlay" style="display:none;">
          <div class="mind-spinner"></div>
          <div class="mind-loader-text">Preparing graph...</div>
        </div>
        <div id="mindMapGate" style="position:absolute;inset:0;background:var(--mantle);box-sizing:border-box;">
          <!-- Absolute-centered card. transform: translate(-50%, -50%) is the
               bulletproof centering primitive — neither flex nor grid quirks
               in the host layout chain can push it off-center. -->
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:18px;width:min(760px, calc(100% - 48px));max-height:calc(100% - 48px);overflow:auto;text-align:center;">
            <div style="font-size:24px;font-weight:700;color:var(--text);letter-spacing:0.2px;">Mind Map</div>
            <div style="font-size:13px;color:var(--subtext0);line-height:1.55;max-width:520px;">A live force-directed view of every note, repo file, recipe, plugin, and saved AI conversation in your brain. Click a node to inspect, drag to pan, scroll to zoom.</div>
            <button type="button" id="mindMapGateBtn" onclick="MindUI.loadMindmap()" style="background:transparent;border:1.5px solid var(--accent);border-radius:8px;color:var(--accent);cursor:pointer;font-size:14px;font-weight:700;padding:12px 26px;letter-spacing:0.3px;transition:background 0.15s, color 0.15s;" onmouseover="this.style.background='var(--accent)';this.style.color='var(--mantle)';" onmouseout="this.style.background='transparent';this.style.color='var(--accent)';">Enter Mind Map</button>
            <!-- Live stats panel: shows the user what's inside before they pay
                 the layout cost. Populated by paintMindmapGate() from state.graph. -->
            <div id="mindGateStats" style="display:none;width:100%;margin-top:6px;"></div>
          </div>
        </div>
      </div>`;

    // Hydrate the controls from saved prefs before the first build so we
    // don't waste a layout on the wrong cap.
    const filterEl = $('mindGraphFilter');
    const capEl = $('mindGraphCap');
    if (filterEl) filterEl.value = state.prefs.graphFilter;
    if (capEl) capEl.value = state.prefs.graphCap;
    paintGraphModeSwitch();
    paintMindmapGate();
    filterEl.addEventListener('change', () => {
      state.prefs.graphFilter = filterEl.value;
      savePrefs();
      if (state.mindmapLoaded) buildNetworkAsync({ loaderText: state.prefs.graphCap === 'all' ? 'Refreshing full graph...' : 'Refreshing graph...' });
    });
    capEl.addEventListener('change', () => {
      state.prefs.graphCap = capEl.value;
      savePrefs();
      if (state.mindmapLoaded) buildNetworkAsync({ loaderText: capEl.value === 'all' ? 'Loading full graph...' : 'Laying out graph...' });
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

  // Semantic palette: color is reserved for kinds whose meaning matters at a
  // glance. Everything else stays neutral grey-white so the eye can find the
  // signal nodes (notes, work items, conversations, plugins) without being
  // drowned in community-cluster decoration. Hubs are emphasised by size and
  // luminance, not hue.
  const NEUTRAL = '#9399b2';
  const NEUTRAL_HUB = '#cdd6f4';
  const KIND_COLOR = {
    note: '#f9e2af',          // human-authored = soft yellow
    conversation: '#94e2d5',  // AI exchange = teal
    drawer: '#94e2d5',        // verbatim turn = teal (same family as conversation)
    workitem: '#f38ba8',      // ADO ticket = red
    plugin: '#cba6f7',        // plugin = mauve
  };
  function kindColor(kind, isHub) {
    if (KIND_COLOR[kind]) return KIND_COLOR[kind];
    return isHub ? NEUTRAL_HUB : NEUTRAL;
  }
  // Shift a hex color toward black or white by a fraction (0..1). Used to derive
  // the darker border + the brighter hub highlight from a single base color so
  // node, border, and halo always feel like one coherent material.
  function shadeHex(hex, lum) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    let n = parseInt(m[1], 16);
    let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    if (lum < 0) {
      r = Math.round(r * (1 + lum)); g = Math.round(g * (1 + lum)); b = Math.round(b * (1 + lum));
    } else {
      r = Math.round(r + (255 - r) * lum); g = Math.round(g + (255 - g) * lum); b = Math.round(b + (255 - b) * lum);
    }
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }
  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(147,153,178,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${a})`;
  }

  const KIND_SHAPE = {
    code: 'dot', doc: 'square', note: 'star', plugin: 'diamond',
    recipe: 'triangle', tag: 'dot', concept: 'dot', conversation: 'hexagon',
    workitem: 'box', image: 'image', paper: 'square',
    // Drawers (verbatim user/assistant turns) get a distinctive triangleDown
    // so they're separable from concept dots and conversation hexagons.
    drawer: 'triangleDown',
  };

  // Hub-emphasising scale (Obsidian-style): pow curve makes high-degree nodes
  // read as visual weight instead of all dots looking the same. Capped so a
  // mega-hub does not eat the viewport.
  function nodeSize(degree) {
    return Math.min(64, Math.max(6, 6 + Math.pow(degree, 0.6) * 4));
  }

  // ── WebGL renderer (3d-force-graph / Three.js) ──────────────────────────────
  // 3D force-directed graph rendered with Three.js. d3-force-3d runs the
  // simulation, OrbitControls handles camera, click → side panel. Look targets
  // the "brain cell" aesthetic from the user's references: glowing fibre
  // edges, axon-pulse particles flowing along trunk lines, sparse star
  // backdrop, hub-trunk colour highlighting like an anatomical map.
  function buildNetwork({ seq = state.graphBuildSeq, onReady = null } = {}) {
    const g = state.graph;
    const host = $('mindCanvasHost');
    if (!host || !g) {
      if (typeof onReady === 'function') onReady();
      return;
    }
    if (typeof window.ForceGraph3D === 'undefined') {
      host.innerHTML = '<div style="padding:20px;color:var(--red);">3D graph lib failed to load. Restart Symphonee.</div>';
      if (typeof onReady === 'function') onReady();
      return;
    }

    const filter = $('mindGraphFilter')?.value || 'all';
    const capRaw = $('mindGraphCap')?.value || '500';
    const cap = capRaw === 'all' ? Infinity : parseInt(capRaw, 10);

    let nodes = g.nodes;
    if (filter !== 'all') nodes = nodes.filter(n => n.kind === filter);
    if (state.prefs.searchOnly && state.search && state.matches.length) {
      const onlySet = new Set(state.matches);
      nodes = nodes.filter(n => onlySet.has(n.id));
    }

    const degree = new Map();
    for (const e of g.edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    if (nodes.length > cap) {
      const ranked = nodes.slice().sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
      const top = ranked.slice(0, cap);
      if (state.search && state.matches.length) {
        const seen = new Set(top.map(n => n.id));
        const matchSetCap = new Set(state.matches);
        for (const n of nodes) {
          if (!seen.has(n.id) && matchSetCap.has(n.id)) top.push(n);
        }
      }
      nodes = top;
    }
    const idSet = new Set(nodes.map(n => n.id));
    const edges = g.edges.filter(e => idSet.has(e.source) && idSet.has(e.target));

    // Top decile by degree = hubs. Drives size + luminance + label visibility.
    const degList = nodes.map(n => degree.get(n.id) || 0).sort((a, b) => b - a);
    const hubThreshold = degList.length ? (degList[Math.max(0, Math.floor(degList.length * 0.1) - 1)] || 0) : 0;

    teardownNetwork();
    state.graphSettled = false;

    // ── Build the data payload ─────────────────────────────────────────────
    // 3d-force-graph wants {nodes:[{id,...}], links:[{source,target,...}]}.
    // We pre-compute all visual properties here so the renderer accessors
    // are pure lookups (cheap on every frame).
    const matchSetNodes = state.search ? new Set(state.matches) : null;
    // Layout-cache hot path: if the server has positions saved for this
    // exact node set, place every node at its cached x/y/z and PIN it via
    // fx/fy/fz. d3-force honors fx/fy/fz as immovable — physics still
    // initializes but every iteration is a no-op for pinned nodes, so the
    // simulation finishes in ~0ms instead of pinning the iGPU for seconds.
    const cached3d = (state.prefs.graphMode !== '2d' && state.layoutCache && state.layoutCache['3d']) || null;
    // Pre-position nodes on a Fibonacci sphere when no cache (cold start).
    // d3-force-3d defaults every node to (0,0,0), which causes the
    // "explosion from middle" animation - all forces fire at full strength
    // against a degenerate starting state.
    const SPHERE_R = 600;
    const N = nodes.length;
    const fgNodes = nodes.map((n, i) => {
      const deg = degree.get(n.id) || 0;
      const isHub = deg >= hubThreshold && deg >= 6;
      const isMatch = matchSetNodes ? matchSetNodes.has(n.id) : false;
      const dim = !!matchSetNodes && !isMatch;
      const baseColor = isMatch ? '#f9e2af' : kindColor(n.kind, isHub);
      let x, y, z, fx, fy, fz;
      const cachedPos = cached3d && cached3d[n.id];
      if (cachedPos && cachedPos.length >= 3) {
        x = cachedPos[0]; y = cachedPos[1]; z = cachedPos[2];
        fx = x; fy = y; fz = z;  // pin
      } else if (state.prefs.graphMode === '2d') {
        // 2D pre-positioning: Fibonacci spiral on a disk. The 3D-sphere
        // formula collapses onto the 2D plane as a clump (lots of nodes
        // share similar (x,y) when z varies) which produces the
        // 'hairball in the middle' look. Fibonacci-spiral disk spreads
        // nodes evenly across the visible area before physics starts.
        const angle = Math.PI * (1 + Math.sqrt(5)) * (i + 0.5);
        const radius = SPHERE_R * Math.sqrt((i + 0.5) / N);
        x = Math.cos(angle) * radius;
        y = Math.sin(angle) * radius;
        z = 0;
      } else {
        // 3D Fibonacci sphere
        const phi = Math.acos(1 - 2 * (i + 0.5) / N);
        const theta = Math.PI * (1 + Math.sqrt(5)) * (i + 0.5);
        x = SPHERE_R * Math.sin(phi) * Math.cos(theta);
        y = SPHERE_R * Math.sin(phi) * Math.sin(theta);
        z = SPHERE_R * Math.cos(phi);
      }
      const out = {
        id: n.id,
        label: n.label,
        kind: n.kind,
        community: n.communityId,
        deg,
        isHub,
        isMatch,
        isDim: dim,
        color: dim ? '#3a3b4a' : baseColor,
        val: Math.max(1.5, Math.pow(deg + 1, 1.1) * 0.8),
        x, y, z,
      };
      // When pinned (cache hit), set fx/fy/fz so the simulation skips
      // every iteration on this node — the heart of the GPU-pin fix.
      if (fx !== undefined) { out.fx = fx; out.fy = fy; out.fz = fz; }
      return out;
    });

    const fgLinks = edges.map((e) => {
      const sDeg = degree.get(e.source) || 0;
      const tDeg = degree.get(e.target) || 0;
      const trunk = sDeg >= hubThreshold && tDeg >= hubThreshold;
      // Opaque hex for edges. We darken the "bulk" colour heavily so it
      // reads as background fibre rather than a solid line.
      let color;
      if (e.confidence === 'AMBIGUOUS') color = '#7a4655';
      else if (e.confidence === 'INFERRED') color = '#3d3540';
      else if (trunk) color = '#7a5640';                  // muted orange
      else color = '#2a3540';                             // muted cyan
      return {
        source: e.source,
        target: e.target,
        color,
        confidence: e.confidence,
        relation: e.relation,
        trunk,
      };
    });

    const data = { nodes: fgNodes, links: fgLinks };

    // ── Build neighbor index for highlight feature ─────────────────────────
    // Pre-compute adjacency so hover/click can dim everything that isn't
    // connected to the focused node in O(1) instead of scanning all edges
    // every frame. This is what makes the highlight example feel instant.
    const neighbors = new Map();    // nodeId -> Set of neighbor nodeIds
    const incidentEdges = new Map(); // nodeId -> Set of link references
    fgNodes.forEach((n) => { neighbors.set(n.id, new Set()); incidentEdges.set(n.id, new Set()); });
    fgLinks.forEach((l) => {
      const s = l.source, t = l.target;
      if (neighbors.has(s)) neighbors.get(s).add(t);
      if (neighbors.has(t)) neighbors.get(t).add(s);
      if (incidentEdges.has(s)) incidentEdges.get(s).add(l);
      if (incidentEdges.has(t)) incidentEdges.get(t).add(l);
    });

    const highlightNodes = new Set();
    const highlightLinks = new Set();
    const clickLinks = new Set();    // separate set for particle-bearing edges (click only)
    let hoverNode = null;
    let lastHoverTime = 0;

    // ── 2D Canvas renderer (vasturiano force-graph) ────────────────────────
    // When graphMode === '2d', short-circuit the 3D path and use the
    // sister 2D library. Same data, same highlight/selection model, same
    // search behaviour - just a flat Canvas projection that's lighter on
    // GPU and easier to read for hub/cluster topology.
    if (state.prefs.graphMode === '2d' && typeof window.ForceGraph !== 'undefined') {
      const cached2d = (state.layoutCache && state.layoutCache['2d']) || null;
      // Apply cached 2D positions (and pin) before handing data to ForceGraph.
      if (cached2d) {
        for (const n of fgNodes) {
          const p = cached2d[n.id];
          if (p && p.length >= 2) { n.x = p[0]; n.y = p[1]; n.fx = p[0]; n.fy = p[1]; }
        }
      }
      const nodeById2d = new Map();
      fgNodes.forEach((n) => nodeById2d.set(n.id, n));
      const initialSize2d = graphHostSize(host);
      const fg2 = window.ForceGraph()(host)
        .width(initialSize2d.width)
        .height(initialSize2d.height)
        .graphData(data)
        .backgroundColor('#11111b')
        .nodeRelSize(4)
        .nodeVal((n) => n.val)
        .nodeColor((n) => {
          if (highlightNodes.size === 0) return n.color;
          if (n === hoverNode) return '#f5e0dc';
          return n.color;
        })
        .nodeVisibility((n) => highlightNodes.size === 0 || highlightNodes.has(n))
        // ── Large-graph fast path (vasturiano/force-graph large-graph example) ──
        // Default node renderer for ForceGraph 2D is shape-based + sprite-based
        // and recomputes per-frame; on a 5k-node graph this dominates frame time.
        // Replacing it with a single arc draw (and a separate, slightly larger
        // hit-test paint) is the canonical 'large graph' optimization. Visually
        // identical for our use case (we already render dots), 5-10x faster.
        .nodeCanvasObjectMode(() => 'replace')
        .nodeCanvasObject((node, ctx, globalScale) => {
          if (typeof node.x !== 'number' || typeof node.y !== 'number') return;
          // Radius scaling: every node clearly visible at any zoom (3px floor),
          // hubs visibly bigger but not eclipsing the rest. sqrt(degree) gives
          // a natural distribution where the gap between deg-0 and deg-1 is
          // already noticeable but deg-50 vs deg-100 isn't dramatic.
          //   deg 0  -> r = 3     (was 2.45 — fixed: now actually visible)
          //   deg 1  -> r = 4.5
          //   deg 5  -> r = 6.4
          //   deg 20 -> r = 9.7
          //   deg 50 -> r = 13.6
          const r = 3 + Math.sqrt(Math.max(0, node.deg || 0)) * 1.5;
          ctx.fillStyle = (highlightNodes.size && node === hoverNode) ? '#f5e0dc' : node.color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
          ctx.fill();
          // Hub ring: only for the small set of high-degree nodes, only when
          // we're zoomed in enough that it's actually visible. Keeps the look
          // without paying for it on every node every frame.
          if (node.isHub && globalScale > 0.6) {
            ctx.strokeStyle = '#a6e3a1';
            ctx.lineWidth = 0.6 / globalScale;
            ctx.stroke();
          }
        })
        // Hit-detection paint: separate offscreen pass with a larger radius so
        // small nodes are still easy to click. Same formula plus a flat +3px
        // hit padding so even zero-degree nodes are comfortably clickable.
        .nodePointerAreaPaint((node, color, ctx) => {
          if (typeof node.x !== 'number') return;
          const r = 3 + Math.sqrt(Math.max(0, node.deg || 0)) * 1.5 + 3;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
          ctx.fill();
        })
        .nodeLabel((n) => `<div style="background:#11111b;border:1px solid #313244;color:#cdd6f4;padding:6px 10px;border-radius:6px;font-family:ui-sans-serif,system-ui;font-size:11px;max-width:320px;"><div style="font-weight:600;margin-bottom:2px;">${escapeHtml(n.label || n.id)}</div><div style="color:#9399b2;font-size:10px;">${escapeHtml(n.kind || '')} - degree ${n.deg}</div></div>`)
        .linkColor((l) => highlightLinks.size === 0 ? l.color : '#fab387')
        .linkVisibility((l) => highlightLinks.size === 0 || highlightLinks.has(l))
        // Thinner default lines (still visible, much less raster work). The
        // large-graph example uses 0.2-0.3 — anything thicker quadratic-bills
        // the rasterizer at this node count.
        .linkWidth(0.3)
        .linkLabel((l) => `<div style="background:#11111b;border:1px solid #313244;color:#cdd6f4;padding:4px 8px;border-radius:4px;font-family:ui-sans-serif,system-ui;font-size:11px;">${escapeHtml(l.relation || 'related')} <span style="color:#9399b2;font-size:10px;">(${escapeHtml(l.confidence || '')})</span></div>`)
        .onNodeClick((n) => {
          state.selectedNode = n.id;
          try { showNodeDetail(n.id); } catch (e) { console.warn('detail', e); }
          highlightNodes.clear(); highlightLinks.clear(); hoverNode = n;
          highlightNodes.add(n);
          const neigh = neighbors.get(n.id);
          if (neigh) for (const nid of neigh) { const f = nodeById2d.get(nid); if (f) highlightNodes.add(f); }
          const inc = incidentEdges.get(n.id);
          if (inc) for (const l of inc) highlightLinks.add(l);
          fg2.nodeColor(fg2.nodeColor()).linkColor(fg2.linkColor()).nodeVisibility(fg2.nodeVisibility()).linkVisibility(fg2.linkVisibility());
          const d = $('mindDeselectBtn'); const s = $('mindShowConnBtn'); const overlay = $('mindCanvasDeselect');
          if (d) d.style.display = ''; if (s) s.style.display = ''; if (overlay) overlay.style.display = '';
          // Frame the selection + neighbours with generous padding instead
          // of forcing a fixed zoom level. Big hubs frame loose; tiny leaf
          // selections still keep enough context around the node so the
          // user isn't slammed into a single circle.
          try { fg2.zoomToFit(700, 120, (m) => highlightNodes.has(m)); } catch (_) {}
        })
        .onBackgroundClick(() => { /* deselect requires the explicit Deselect button — clicking empty space no longer clears the selection. */ })
        .onNodeHover((n) => { host.style.cursor = n ? 'pointer' : ''; })
        // Cache hit -> physics is a no-op (every node is pinned). Drop
        // both warmup and cooldown to zero so the first frame is the
        // final frame and the iGPU stays at idle.
        // Cache miss on 2D: 250 warmup ticks (matching 3D) so a 6k+ node
        // graph actually has time to spread out. 120 was too few — nodes
        // started on the Fibonacci-spiral disk but didn't have enough
        // iterations for charge + collide to push them apart.
        .cooldownTicks(cached2d ? 0 : 60)
        .warmupTicks(cached2d ? 0 : 250)
        .d3AlphaDecay(0.04)
        .d3VelocityDecay(0.55);
      try {
        if (fg2.d3Force) {
          // Force tuning for big graphs. -450 charge was way too weak for
          // 6800 nodes — the inner cluster never got enough push to spread.
          // Bumped to -1800 (4x), distanceMax doubled so far-away nodes
          // still feel each other, and link.strength dropped so densely
          // connected hubs don't collapse into a tight blob.
          const charge = fg2.d3Force('charge');
          if (charge && charge.strength) charge.strength(-1800);
          if (charge && charge.distanceMax) charge.distanceMax(2800);
          const link = fg2.d3Force('link');
          if (link && link.distance) link.distance(180);
          if (link && link.strength) link.strength(0.15);
          const center = fg2.d3Force('center');
          // Center force way down — was pulling everything back into the
          // middle, fighting the charge force we just amped up.
          if (center && center.strength) center.strength(0.003);
          // Custom collision force (vasturiano/force-graph doesn't expose
          // d3 directly, so we register our own grid-bucketed collide).
          // Each tick bucketizes nodes by 2*maxRadius cells, then resolves
          // overlaps within neighbouring cells. O(n) average for sparse
          // hubs; safe up to ~10k nodes at 60fps.
          const collide = (function() {
            let nodes;
            const padding = 3;
            const radiusOf = (n) => Math.sqrt(Math.max(0.5, n.val || 1)) * 4 + 1;
            function force(alpha) {
              if (!nodes || !nodes.length) return;
              let maxR = 0;
              const radii = new Array(nodes.length);
              for (let i = 0; i < nodes.length; i++) {
                const r = radiusOf(nodes[i]);
                radii[i] = r;
                if (r > maxR) maxR = r;
              }
              const cell = (maxR + padding) * 2 || 8;
              const grid = new Map();
              for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
                const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
                const key = cx + ':' + cy;
                let bucket = grid.get(key);
                if (!bucket) { bucket = []; grid.set(key, bucket); }
                bucket.push(i);
              }
              for (let i = 0; i < nodes.length; i++) {
                const a = nodes[i];
                if (typeof a.x !== 'number') continue;
                const cx = Math.floor(a.x / cell), cy = Math.floor(a.y / cell);
                for (let gx = -1; gx <= 1; gx++) {
                  for (let gy = -1; gy <= 1; gy++) {
                    const bucket = grid.get((cx + gx) + ':' + (cy + gy));
                    if (!bucket) continue;
                    for (let k = 0; k < bucket.length; k++) {
                      const j = bucket[k];
                      if (j <= i) continue;
                      const b = nodes[j];
                      const ddx = b.x - a.x;
                      const ddy = b.y - a.y;
                      let dist = Math.hypot(ddx, ddy);
                      if (dist === 0) { dist = 0.01; }
                      const r = radii[i] + radii[j] + padding;
                      if (dist < r) {
                        const overlap = (r - dist) / dist * 0.5 * Math.min(1, alpha * 4 + 0.4);
                        const mx = ddx * overlap, my = ddy * overlap;
                        a.x -= mx; a.y -= my;
                        b.x += mx; b.y += my;
                      }
                    }
                  }
                }
              }
            }
            force.initialize = (n) => { nodes = n; };
            return force;
          })();
          fg2.d3Force('collide', collide);
        }
      } catch (_) {}
      // ── Trackpad+mouse zoom-to-cursor ──────────────────────────────────────
      // force-graph's built-in d3-zoom barely moves on a Windows trackpad
      // because two-finger swipe deltas are tiny (deltaMode=0, ~1-10 px). We
      // intercept wheel in capture phase, normalise across deltaMode + pinch,
      // and drive fg2.zoom() with cursor anchoring so the world point under
      // the cursor stays put — same feel as Figma / the 3D path above.
      // Track zoom locally too: some bundles of vasturiano/force-graph return
      // the chain (not the number) from `.zoom()` getter, which would NaN out
      // the math and silently kill all wheel zoom.
      let zoomLevel2d = 1;
      host.addEventListener('wheel', (ev) => {
        try {
          if (typeof fg2.zoom !== 'function') return;
          ev.preventDefault();
          ev.stopPropagation();
          let delta = ev.deltaY;
          if (ev.deltaMode === 1) delta *= 16;
          else if (ev.deltaMode === 2) delta *= host.clientHeight || 600;
          // Pinch-zoom on a trackpad arrives as wheel + ctrlKey with small
          // magnitudes; bump sensitivity so a pinch feels proportional.
          const sensitivity = ev.ctrlKey ? 0.012 : 0.0025;
          const factor = Math.exp(-delta * sensitivity);
          let curZoom = zoomLevel2d;
          try {
            const probe = fg2.zoom();
            if (typeof probe === 'number' && isFinite(probe) && probe > 0) curZoom = probe;
          } catch (_) {}
          const newZoom = Math.max(0.05, Math.min(40, curZoom * factor));
          if (!isFinite(newZoom) || Math.abs(newZoom - curZoom) < 1e-6) return;
          const rect = host.getBoundingClientRect();
          const cx = ev.clientX - rect.left;
          const cy = ev.clientY - rect.top;
          let before = null;
          try {
            if (typeof fg2.screen2GraphCoords === 'function') before = fg2.screen2GraphCoords(cx, cy);
          } catch (_) {}
          fg2.zoom(newZoom, 0);
          zoomLevel2d = newZoom;
          if (before && typeof fg2.centerAt === 'function' && typeof fg2.screen2GraphCoords === 'function') {
            try {
              const after = fg2.screen2GraphCoords(cx, cy);
              const center = fg2.centerAt();
              if (after && center && typeof center.x === 'number' && typeof center.y === 'number') {
                fg2.centerAt(center.x + (before.x - after.x), center.y + (before.y - after.y), 0);
              }
            } catch (_) {}
          }
        } catch (_) {}
      }, { passive: false, capture: true });
      try { host.style.opacity = '0'; } catch (_) {}
      // Same trick as the 3D path (Codex's fix): force-graph caches the
      // host's size at construction. Wire a ResizeObserver + window-resize
      // fallback so the canvas tracks the host's flex dimensions instead
      // of stretching against a stale width that pushes the layout into
      // the bottom-right corner of the visible area.
      const resizeGraph2 = () => { try { syncGraphSize(fg2, host); } catch (_) {} };
      if (typeof ResizeObserver !== 'undefined') {
        try {
          const ro = new ResizeObserver(resizeGraph2);
          ro.observe(host);
          state.fgResizeObserver = ro;
        } catch (_) {}
      }
      try { window.addEventListener('resize', resizeGraph2); state.fgResizeHandler = resizeGraph2; } catch (_) {}
      // 2D Canvas has the same iGPU-handoff issue: comes back garbled or
      // black after the Symphonee window loses focus. Same recovery
      // helper, with mode='2d' so it knows the surface is Canvas2D rather
      // than WebGL and skips the GL-specific listeners.
      attachGraphRecovery(host, () => fg2, '2d');
      let firstStop2 = true;
      fg2.onEngineStop(() => {
        if (!firstStop2) return;
        firstStop2 = false;
        state.graphSettled = true;
        // Persist positions so the next 2D open is a zero-physics paint.
        if (!cached2d) persistLayout('2d', fg2);
        try {
          syncGraphSize(fg2, host);
          fg2.zoomToFit(0, 80);
        } catch (_) {}
        try { host.style.transition = 'opacity 400ms ease-out'; host.style.opacity = '1'; } catch (_) {}
        // FULL freeze. force-graph's soft cooldown leaves residual alpha
        // and the centre/charge forces keep tugging nodes upward and into
        // the middle even after onEngineStop. The bullet-proof recipe:
        //   1. Remove every force (charge, link, center, collide).
        //   2. Zero velocities on every node.
        //   3. Pin x/y by writing fx/fy (d3 honours these as fixed positions).
        //   4. alphaTarget(0).alpha(0).stop() the simulation.
        //   5. pauseAnimation() so the rAF render loop stops too.
        // After this, nodes only move when the user drags them (and even
        // then they snap back since fx/fy are pinned).
        try {
          if (fg2.d3Force) {
            ['charge','link','center','collide'].forEach((name) => {
              try { fg2.d3Force(name, null); } catch (_) {}
            });
          }
          const live = (fg2.graphData && fg2.graphData().nodes) || data.nodes;
          for (const node of live) {
            node.vx = 0; node.vy = 0;
            node.fx = node.x; node.fy = node.y;
          }
          if (fg2.d3AlphaTarget) fg2.d3AlphaTarget(0);
          if (fg2.d3AlphaMin) fg2.d3AlphaMin(1);
          if (typeof fg2.d3VelocityDecay === 'function') fg2.d3VelocityDecay(1);
          // Do NOT pauseAnimation() in 2D - that stops the render loop too,
          // and force-graph's d3-zoom updates the transform but cannot repaint
          // until the next rAF. With forces removed and every node pinned
          // via fx/fy the simulation tick is a no-op anyway, so leaving the
          // render loop running is essentially free and keeps wheel zoom +
          // drag-pan responsive.
        } catch (_) {}
        setTimeout(() => { if (typeof onReady === 'function') onReady(); }, 480);
      });
      state.fg = fg2;
      state.fg2D = true;
      state.fgClearHighlight = () => {
        highlightNodes.clear(); highlightLinks.clear(); hoverNode = null;
        state.selectedNode = null;
        fg2.nodeColor(fg2.nodeColor()).linkColor(fg2.linkColor()).nodeVisibility(fg2.nodeVisibility()).linkVisibility(fg2.linkVisibility());
        const d = $('mindDeselectBtn'); const s = $('mindShowConnBtn'); const overlay = $('mindCanvasDeselect');
        if (d) d.style.display = 'none'; if (s) s.style.display = 'none'; if (overlay) overlay.style.display = 'none';
        // Close the right-side detail panel - selection is being cleared.
        const dp = $('mindDetail'); if (dp) dp.style.display = 'none';
      };
      state.fgShowConnected = () => {
        if (highlightNodes.size === 0) return;
        try { fg2.zoomToFit(700, 60, (n) => highlightNodes.has(n)); } catch (_) {}
      };
      state.sigmaLayoutCancel = () => { try { fg2.pauseAnimation(); } catch (_) {} };
      state.fgRevealFallback = setTimeout(() => {
        if (firstStop2) { firstStop2 = false; try { fg2.zoomToFit(0, 60); host.style.opacity = '1'; } catch (_) {} if (typeof onReady === 'function') onReady(); }
      }, 8000);
      return;
    }

    // ── Construct the 3D renderer ──────────────────────────────────────────
    // Perf-tuned: antialias off, low sphere resolution, no curvature, no
    // particles, no starfield. The vasturiano example pages run 5k nodes at
    // 60fps with these defaults - copying the recipe.
    const initialSize = graphHostSize(host);
    const fg = window.ForceGraph3D()(host, {
      rendererConfig: {
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
        // Keep the last drawn frame in the buffer so a brief context blip
        // (alt-tab on iGPUs) doesn't show garbled / black before the next
        // requestAnimationFrame fires. Costs a tiny bit of memory; worth it.
        preserveDrawingBuffer: true,
        // Tell the GPU we want to recover automatically if the context
        // gets revoked, instead of giving up permanently.
        failIfMajorPerformanceCaveat: false,
      },
    })
      .width(initialSize.width)
      .height(initialSize.height)
      .graphData(data)
      .backgroundColor('#11111b')
      .showNavInfo(false)

      // Nodes: WebGL spheres. Drop resolution from 10 to 6 segments (2.7x
      // fewer triangles per node, near-imperceptible visually).
      .nodeRelSize(5)
      .nodeVal((n) => n.val)
      .nodeColor((n) => {
        if (highlightNodes.size === 0) return n.color;
        if (n === hoverNode) return '#f5e0dc';
        return n.color;
      })
      // When a node is selected, hide every node that isn't the selection
      // or one of its neighbors. nodeVisibility is FAR cheaper than alpha
      // because invisible nodes are skipped by the renderer entirely
      // (no draw call, no depth sort).
      .nodeVisibility((n) => highlightNodes.size === 0 || highlightNodes.has(n))
      .nodeOpacity(1)
      .nodeResolution(8)
      // Hover tooltip (DOM, hover-only - no per-frame cost).
      .nodeLabel((n) => `<div style="background:#11111b;border:1px solid #313244;color:#cdd6f4;padding:6px 10px;border-radius:6px;font-family:ui-sans-serif,system-ui;font-size:11px;max-width:320px;"><div style="font-weight:600;margin-bottom:2px;">${escapeHtml(n.label || n.id)}</div><div style="color:#9399b2;font-size:10px;">${escapeHtml(n.kind || '')} - degree ${n.deg}</div></div>`)

      // Links: straight lines (no curvature). Width / opacity react to
      // highlight state - that's the highlight example's effect.
      .linkColor((l) => {
        if (highlightLinks.size === 0) return l.color;
        return '#fab387';
      })
      .linkVisibility((l) => highlightLinks.size === 0 || highlightLinks.has(l))
      .linkOpacity(0.12)
      .linkWidth(0)
      // Hover tooltip for edges shows the relation (text-links example
      // ported as DOM tooltip - per-edge sprites are ~20x more expensive).
      .linkLabel((l) => `<div style="background:#11111b;border:1px solid #313244;color:#cdd6f4;padding:4px 8px;border-radius:4px;font-family:ui-sans-serif,system-ui;font-size:11px;">${escapeHtml(l.relation || 'related')} <span style="color:#9399b2;font-size:10px;">(${escapeHtml(l.confidence || '')})</span></div>`)
      // No particles. They allocate/dispose Three.js meshes which keeps the
      // GC busy and never lets idle frames be cheap. Highlight reads through
      // color + width changes alone - those are accessor lookups, no
      // mesh churn.

      // ── Click-to-highlight + click-to-focus ──────────────────────────────
      // Hover highlighting was removed - it caused frame drops on accidental
      // mouse movement. Click is intentional, predictable, and only fires
      // once per intent. Background click clears.
      .onNodeClick((n) => {
        state.selectedNode = n.id;
        try { showNodeDetail(n.id); } catch (e) { console.warn('detail', e); }
        applyHighlight(n);
        // While a node is selected, disable the controls' built-in pan
        // entirely. Pan would translate camera + target in lockstep,
        // dragging the orbit pivot off the selected node and breaking
        // the "selection is the centre" rule.
        try {
          const c = fg.controls && fg.controls();
          if (c) { c.noPan = true; c.enablePan = false; }
        } catch (_) {}
        // Frame the selection: orbit pivot becomes the clicked node, and
        // the camera pulls back just enough to fit the highlighted cluster
        // (selection + neighbors). Setting the lookAt to the node itself
        // makes the trackball/orbit rotation pivot AROUND the selection
        // instead of the global graph centre.
        //
        // showNodeDetail() above reveals the right-side flex sibling, which
        // shrinks mindMain and the canvas by 340px. 3d-force-graph has no
        // internal ResizeObserver, so sync its width/height before issuing
        // the camera move. Otherwise it projects against a stale, oversized
        // WebGL viewport and the node lands down/right of the visible centre.
        const focusOnNode = () => {
          try {
            syncGraphSize(fg, host);
            const cam = fg.camera();
            if (!cam || !cam.position) return;
            // Radius needed to contain selection + neighbors.
            let maxR = 0;
            for (const m of highlightNodes) {
              const dx = (m.x || 0) - (n.x || 0);
              const dy = (m.y || 0) - (n.y || 0);
              const dz = (m.z || 0) - (n.z || 0);
              const r = Math.hypot(dx, dy, dz);
              if (r > maxR) maxR = r;
            }
            const dist = Math.max(220, maxR * 2.4);
            // Preserve the current viewing angle: pull back along the
            // existing camera-to-node direction.
            const fx = cam.position.x - (n.x || 0);
            const fy = cam.position.y - (n.y || 0);
            const fz = cam.position.z - (n.z || 0);
            const fLen = Math.hypot(fx, fy, fz) || 1;
            const camPos = {
              x: (n.x || 0) + (fx / fLen) * dist,
              y: (n.y || 0) + (fy / fLen) * dist,
              z: (n.z || 0) + (fz / fLen) * dist,
            };
            const lookAt = { x: n.x || 0, y: n.y || 0, z: n.z || 0 };
            fg.cameraPosition(camPos, lookAt, 700);
            // Belt-and-suspenders: 720ms after the animation, force the
            // orbit pivot to snap to exactly the selected node's position
            // (which may have drifted slightly while the simulation was
            // still ticking) and re-centre the camera on it.
            setTimeout(() => {
              try {
                const ctrls = fg.controls && fg.controls();
                if (ctrls && ctrls.target) {
                  ctrls.target.x = n.x || 0;
                  ctrls.target.y = n.y || 0;
                  ctrls.target.z = n.z || 0;
                  if (typeof cam.lookAt === 'function') cam.lookAt(ctrls.target);
                  if (typeof ctrls.update === 'function') ctrls.update();
                }
              } catch (_) {}
            }, 720);
          } catch (_) {}
        };
        // Two rAFs give the flex layout a full paint cycle after the detail
        // panel appears; then we explicitly resize the graph in focusOnNode.
        requestAnimationFrame(() => requestAnimationFrame(focusOnNode));
      })
      .onBackgroundClick(() => { /* deselect requires the explicit Deselect button — clicking empty space no longer clears the selection. */ })
      .onNodeHover((n) => { host.style.cursor = n ? 'pointer' : ''; })
      .enableNodeDrag(false)

      // Pre-warm the simulation HARD so the graph is fully settled before
      // first paint. warmupTicks runs synchronously and blocks the main
      // thread for ~1-2s on a 200-node graph - acceptable because we keep
      // the loader up for that whole window. The reward is zero animation
      // jitter when the graph appears.
      .cooldownTicks(0)
      // When the layout cache supplied positions for every node, skip the
      // synchronous 250-tick warmup entirely. Render becomes a one-frame
      // operation instead of a 1-2s GPU pin.
      .warmupTicks(cached3d ? 0 : 250)
      .d3AlphaDecay(0.06)
      .d3VelocityDecay(0.55);

    // ── Highlight helpers ───────────────────────────────────────────────────
    // Build a node-id → node-object lookup once instead of .find() per call.
    const nodeById = new Map();
    fgNodes.forEach((n) => nodeById.set(n.id, n));

    // Cheap re-evaluation: re-pass each accessor as itself. This is the
    // documented pattern from vasturiano's highlight example - it tells
    // 3d-force-graph to re-read the accessors without rebuilding scene
    // resources, which is the difference between 60fps and 10fps on hover.
    function repaintAccessors() {
      try {
        fg.nodeColor(fg.nodeColor())
          .nodeVisibility(fg.nodeVisibility())
          .linkColor(fg.linkColor())
          .linkVisibility(fg.linkVisibility())
          .linkWidth(fg.linkWidth());
      } catch (_) {}
    }

    function applyHighlight(node) {
      highlightNodes.clear();
      highlightLinks.clear();
      clickLinks.clear();
      hoverNode = node;
      highlightNodes.add(node);
      const neigh = neighbors.get(node.id);
      if (neigh) {
        for (const nid of neigh) {
          const found = nodeById.get(nid);
          if (found) highlightNodes.add(found);
        }
      }
      const incident = incidentEdges.get(node.id);
      if (incident) {
        for (const l of incident) {
          highlightLinks.add(l);
          clickLinks.add(l);
        }
      }
      repaintAccessors();
      toggleSelectionButtons(true);
    }
    function clearHighlight() {
      highlightNodes.clear();
      highlightLinks.clear();
      clickLinks.clear();
      hoverNode = null;
      state.selectedNode = null;
      repaintAccessors();
      toggleSelectionButtons(false);
      // Close the right-side detail panel so deselect feels like a true
      // "back to overview" - sidebar context belongs to the prior selection.
      try { const dp = $('mindDetail'); if (dp) dp.style.display = 'none'; } catch (_) {}
      // Restore the orbit pivot to the graph centre so deselecting feels
      // like "back to overview" and rotation again spans the whole map.
      // Also re-enable pan, which we disable while a node is selected.
      try {
        const ctrls = fg.controls && fg.controls();
        if (ctrls && ctrls.target) {
          ctrls.target.x = 0; ctrls.target.y = 0; ctrls.target.z = 0;
          ctrls.noPan = false;
          ctrls.enablePan = true;
          if (typeof ctrls.update === 'function') ctrls.update();
        }
      } catch (_) {}
    }
    function toggleSelectionButtons(hasSelection) {
      const d = $('mindDeselectBtn');
      const s = $('mindShowConnBtn');
      const overlay = $('mindCanvasDeselect');
      if (d) d.style.display = hasSelection ? '' : 'none';
      if (s) s.style.display = hasSelection ? '' : 'none';
      if (overlay) overlay.style.display = hasSelection ? '' : 'none';
    }
    // Frame the currently-highlighted nodes (selected + neighbors) in view.
    state.fgShowConnected = function() {
      if (!fg || highlightNodes.size === 0) return;
      try {
        // zoomToFit accepts a filter so it fits ONLY the highlighted nodes.
        fg.zoomToFit(700, 80, (n) => highlightNodes.has(n));
        setTimeout(() => panCameraForSidebar(fg, 700), 750);
      } catch (_) {}
    };

    // ── Wide dispersion: connected pairs further apart ───────────────────
    // Previous link.distance of 60 still left edge-connected nodes feeling
    // crammed. 130 gives clear breathing room between every connected
    // pair. Charge bumped to match - without proportionally stronger
    // repulsion, longer springs would let unconnected leaves crash into
    // each other.
    try {
      if (fg.d3Force) {
        const charge = fg.d3Force('charge');
        if (charge && charge.strength) charge.strength(-350);
        if (charge && charge.distanceMax) charge.distanceMax(1200);
        const link = fg.d3Force('link');
        if (link && link.distance) link.distance(130);
        if (link && link.strength) link.strength(0.4);
        const center = fg.d3Force('center');
        if (center && center.strength) center.strength(0.015);
      }
    } catch (_) {}

    // ── Slower OrbitControls ──────────────────────────────────────────────
    // Defaults are tuned for tiny demo scenes; they feel jittery with our
    // larger graph. Halving rotateSpeed + softer zoom feels much better.
    try {
      const ctrls = fg.controls && fg.controls();
      if (ctrls) {
        ctrls.rotateSpeed = 0.4;
        // Pan was too snappy at 0.5 - hard to drift across the graph.
        // 0.2 lands closer to "scrub" feel.
        ctrls.dynamicDampingFactor = ctrls.dynamicDampingFactor || 0.18;
        ctrls.zoomSpeed = 0.6;
        ctrls.panSpeed = 0.08;
        if ('enableDamping' in ctrls) {
          ctrls.enableDamping = true;
          ctrls.dampingFactor = 0.12;
        }
        // We replace the default wheel-zoom with a custom zoom-to-cursor.
        // TrackballControls expose `noZoom`; OrbitControls expose
        // `enableZoom`. Set both so this works regardless of which one
        // 3d-force-graph instantiated.
        ctrls.noZoom = true;
        ctrls.enableZoom = false;
        // Lock the orbit pivot to the selected node, even mid-pan. The
        // controls translate BOTH camera and target in lockstep when the
        // user pans, which would drag the pivot off the selection. We
        // listen for every change event and re-anchor target back to the
        // selected node's position, leaving the camera where the pan put
        // it. End result: rotation always spins around the selected node
        // regardless of how the user has panned the view.
        if (typeof ctrls.addEventListener === 'function') {
          ctrls.addEventListener('change', () => {
            if (!state.selectedNode) return;
            const node = nodeById.get(state.selectedNode);
            if (!node || typeof node.x !== 'number') return;
            // Tolerance check avoids fighting damping for sub-pixel drift.
            const dx = ctrls.target.x - node.x;
            const dy = ctrls.target.y - node.y;
            const dz = ctrls.target.z - node.z;
            if (dx * dx + dy * dy + dz * dz < 0.0001) return;
            ctrls.target.x = node.x;
            ctrls.target.y = node.y;
            ctrls.target.z = node.z;
          });
        }
      }
    } catch (_) {}

    // ── Zoom-to-cursor ─────────────────────────────────────────────────────
    // Native trackball/orbit zoom always pulls toward the lookAt target,
    // which feels wrong when the user is hovering somewhere else. Custom
    // wheel handler: project the cursor into world space at the current
    // target's depth, then move BOTH the camera and the orbit pivot toward
    // (or away from) that point. This is the standard CAD/Figma feel.
    host.addEventListener('wheel', (ev) => {
      try {
        const cam = fg.camera && fg.camera();
        const ctrls = fg.controls && fg.controls();
        if (!cam || !ctrls || !ctrls.target || !cam.position) return;
        ev.preventDefault();
        ev.stopPropagation();
        const step = 0.12;
        const s = ev.deltaY < 0 ? step : -step;
        if (state.selectedNode) {
          // Selected mode: pure radial zoom toward / away from the orbit
          // target (= the selected node). Do NOT move laterally toward
          // the cursor — that would push the node off centre, defeating
          // "the selected node is the middle".
          const dx = ctrls.target.x - cam.position.x;
          const dy = ctrls.target.y - cam.position.y;
          const dz = ctrls.target.z - cam.position.z;
          cam.position.x += dx * s;
          cam.position.y += dy * s;
          cam.position.z += dz * s;
        } else {
          // No selection: classic CAD/Figma zoom-to-cursor. Project the
          // cursor into world space at the current target's depth and
          // lerp BOTH camera and target toward (or away from) that point.
          // Both move so the orbit pivot drifts to whatever the user is
          // looking at — "the middle is the middle" stays true.
          const Vec3 = cam.up && cam.up.constructor;
          if (!Vec3) return;
          const rect = host.getBoundingClientRect();
          const w = rect.width || host.clientWidth || 1;
          const h = rect.height || host.clientHeight || 1;
          const ndcX = ((ev.clientX - rect.left) / w) * 2 - 1;
          const ndcY = -(((ev.clientY - rect.top) / h) * 2 - 1);
          const ray = new Vec3(ndcX, ndcY, 0.5);
          if (typeof ray.unproject === 'function') ray.unproject(cam);
          const dir = new Vec3(ray.x - cam.position.x, ray.y - cam.position.y, ray.z - cam.position.z);
          const dirLen = Math.hypot(dir.x, dir.y, dir.z) || 1;
          dir.x /= dirLen; dir.y /= dirLen; dir.z /= dirLen;
          const fx = ctrls.target.x - cam.position.x;
          const fy = ctrls.target.y - cam.position.y;
          const fz = ctrls.target.z - cam.position.z;
          const fLen = Math.hypot(fx, fy, fz) || 1;
          const nx = fx / fLen, ny = fy / fLen, nz = fz / fLen;
          const denom = dir.x * nx + dir.y * ny + dir.z * nz;
          if (Math.abs(denom) < 1e-6) return;
          const t = (fx * nx + fy * ny + fz * nz) / denom;
          const hitX = cam.position.x + dir.x * t;
          const hitY = cam.position.y + dir.y * t;
          const hitZ = cam.position.z + dir.z * t;
          cam.position.x += (hitX - cam.position.x) * s;
          cam.position.y += (hitY - cam.position.y) * s;
          cam.position.z += (hitZ - cam.position.z) * s;
          ctrls.target.x += (hitX - ctrls.target.x) * s;
          ctrls.target.y += (hitY - ctrls.target.y) * s;
          ctrls.target.z += (hitZ - ctrls.target.z) * s;
        }
        cam.lookAt(ctrls.target);
        if (typeof ctrls.update === 'function') ctrls.update();
      } catch (_) {}
    }, { passive: false, capture: true });

    state.fg = fg;
    // ── Context-loss + focus-loss recovery ─────────────────────────────────
    // When Symphonee loses the GPU (alt-tab on iGPUs, lock screen, GPU
    // process restart) the WebGL canvas comes back black or with garbled
    // texture residue. Three.js auto-recovers when given the chance —
    // we just need to (a) prevent the default 'lose forever' behavior on
    // webglcontextlost, (b) trigger a re-render once webglcontextrestored
    // fires, and (c) on plain window-focus return, force one fresh frame
    // even if the GL context never officially died.
    attachGraphRecovery(host, () => fg, '3d');
    state.fgClearHighlight = clearHighlight;

    const resizeGraph = () => {
      syncGraphSize(fg, host);
      try { fg.resumeAnimation(); } catch (_) {}
      clearTimeout(state.fgResizePause);
      state.fgResizePause = setTimeout(() => {
        try { if (state.graphSettled) fg.pauseAnimation(); } catch (_) {}
      }, 150);
    };
    resizeGraph();
    if (typeof ResizeObserver !== 'undefined') {
      try {
        const ro = new ResizeObserver(resizeGraph);
        ro.observe(host);
        state.fgResizeObserver = ro;
      } catch (_) {}
    } else {
      state.fgResizeHandler = resizeGraph;
      window.addEventListener('resize', resizeGraph);
    }

    // ── GPU cap: pixelRatio:1 ──────────────────────────────────────────────
    // The one safe GPU win: cap the WebGL renderer's pixel ratio at 1. On a
    // hi-DPI / 4K monitor Three.js was filling 4x the pixels per frame for
    // no perceptual gain on a graph viz. This alone drops GPU 50-75% on
    // those displays and can't crash.
    try {
      const renderer = fg.renderer && fg.renderer();
      if (renderer && renderer.setPixelRatio) renderer.setPixelRatio(1);
    } catch (_) {}

    // ── Pause-on-idle (mandatory per profiler) ─────────────────────────────
    // The DevTools profile showed 3d-force-graph burning 8.6s of CPU in a 9s
    // recording (96% of frames). The renderer keeps painting every frame
    // even when the scene is static. Pausing on settle and resuming on
    // mouse interaction drops idle GPU/CPU to near zero.
    let pauseTimer = null;
    const wake = () => {
      try { fg.resumeAnimation(); } catch (_) {}
      clearTimeout(pauseTimer);
      // 600ms is enough to cover OrbitControls damping after the user lets
      // go of the mouse. Shorter than before (1000ms) - idle GPU drops
      // sooner, profile spent less time in renderer.
      pauseTimer = setTimeout(() => {
        try { fg.pauseAnimation(); } catch (_) {}
      }, 600);
    };
    // Plain DOM events on the host. mousemove fires constantly during
    // drag/orbit, which keeps the timer extending. When the user stops
    // touching the canvas, 1s later the renderer pauses.
    host.addEventListener('mousedown', wake);
    host.addEventListener('mousemove', wake);
    host.addEventListener('wheel', wake);
    host.addEventListener('touchstart', wake);
    state.fgWake = wake;

    state.sigmaLayoutCancel = () => {
      try { fg.pauseAnimation(); } catch (_) {}
      clearTimeout(pauseTimer);
    };

    // Hide the canvas until the simulation has fully settled. The user
    // sees a clean loader instead of the scramble-into-place animation.
    try { host.style.opacity = '0'; } catch (_) {}

    let firstStop = true;
    const reveal = () => {
      if (!firstStop) return;
      firstStop = false;
      // Fit the camera + sidebar-offset BEFORE fading in, so the graph
      // appears already centered in the visible (non-sidebar) area.
      try {
        syncGraphSize(fg, host);
        // Initial overview: read the canonical node positions from
        // 3d-force-graph's internal graphData (the simulation may have
        // replaced our objects), build an axis-aligned bounding box,
        // then route the camera through the public cameraPosition()
        // API. Driving the library API instead of mutating cam.position
        // directly ensures 3d-force-graph's internal control/render
        // state agrees with what we just set, so it doesn't re-apply a
        // stale transform on the next animation frame.
        const liveNodes = (fg.graphData && fg.graphData().nodes) || fgNodes;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const n of liveNodes) {
          if (typeof n.x !== 'number') continue;
          if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
          if (typeof n.z === 'number') {
            if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z;
          }
        }
        if (!isFinite(minZ)) { minZ = 0; maxZ = 0; }
        if (isFinite(minX) && isFinite(maxX)) {
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const cz = (minZ + maxZ) / 2;
          const halfDiag = Math.hypot(maxX - cx, maxY - cy, maxZ - cz) || 200;
          const dist = halfDiag * 1.9;
          fg.cameraPosition(
            { x: cx, y: cy, z: cz + dist },
            { x: cx, y: cy, z: cz },
            0
          );
        } else {
          fg.zoomToFit(0, 240);
        }
      } catch (_) {}
      try {
        // Compile shaders and draw the first WebGL frame while the loader
        // still covers the canvas. Without this, shader/material upload can
        // happen after opacity flips to 1, leaving a visible blank canvas.
        forceGraphRenderFrame(fg, host);
      } catch (_) {}
      try { host.style.transition = 'opacity 400ms ease-out'; host.style.opacity = '1'; } catch (_) {}
      waitForGraphPaint(fg, host).then(() => {
        try { fg.pauseAnimation(); } catch (_) {}
        // Hold the loader up through the 400ms fade-in so the user never
        // sees a blank canvas between the loader hiding and the graph
        // becoming visible. The +80ms cushion covers the compositor frame.
        setTimeout(() => { if (typeof onReady === 'function') onReady(); }, 480);
      });
    };
    fg.onEngineStop(() => {
      state.graphSettled = true;
      // Persist the now-stable positions so the next load skips physics.
      // Only save when we ran a real simulation (cache miss); otherwise
      // we'd just be re-saving the same numbers we loaded.
      if (!cached3d) persistLayout('3d', fg);
      // Settle buffer: even after the engine reports stop, Three.js often
      // needs another second to finish its last few draw calls and settle
      // material caches. Holding the loader for ~1.2s extra eliminates
      // the "appears, then is laggy for 5 seconds" complaint.
      setTimeout(reveal, cached3d ? 200 : 1200);
    });

    // Fallback: if onEngineStop never fires (worker issue, etc), reveal
    // after a hard timeout so the user isn't stuck staring at a loader.
    const revealFallback = setTimeout(reveal, 8000);
    state.fgRevealFallback = revealFallback;
  }

  // ── Graph context-loss + focus recovery ───────────────────────────────────
  // Hooks four events on the canvas + window so a backgrounded Symphonee
  // recovers cleanly:
  //   webglcontextlost      -> preventDefault so Three.js gets a chance to
  //                            restore (without this the GL context is
  //                            torn down permanently).
  //   webglcontextrestored  -> rebuild the renderer and force a frame.
  //   visibilitychange      -> when Symphonee becomes visible again, ask
  //                            the force-graph to re-render even if the GL
  //                            context never officially died (catches the
  //                            'comes back grey/garbled' case).
  //   window 'focus'        -> belt-and-suspenders; some Windows compositors
  //                            don't fire visibilitychange on alt-tab.
  //
  // All listeners are tracked on state.fgRecoveryHandlers so teardownNetwork
  // can remove them. mode is '3d' (WebGL via Three.js) or '2d' (Canvas2D).
  function attachGraphRecovery(host, getInstance, mode) {
    if (state.fgRecoveryHandlers) detachGraphRecovery();
    const handlers = { canvas: null, lost: null, restored: null, vis: null, focus: null, mode };

    function findCanvas() {
      // Both 3d-force-graph and the 2D ForceGraph mount their <canvas>
      // inside the host. WebGL is the first canvas in 3D mode; 2D mode has
      // its own. Either way, we just want every canvas in scope.
      try { return Array.from(host.querySelectorAll('canvas')); }
      catch (_) { return []; }
    }

    function forceRedraw() {
      const fg = getInstance && getInstance();
      if (!fg) return;
      try {
        // 1. RE-SYNC THE CANVAS BACKING STORE. The actual visible bug:
        //    after a window restore, the host div has its current CSS
        //    pixel size but the canvas's internal width/height attributes
        //    are stale (whatever they were when focus was lost). Three.js
        //    sets its GL viewport from those internal dims, so we get a
        //    correctly-rendered 3D scene in the middle and the rest of
        //    the canvas is black. Telling force-graph the new host size
        //    rebuilds the canvas backing store + GL viewport in one shot.
        const w = host.clientWidth || host.offsetWidth || 0;
        const h = host.clientHeight || host.offsetHeight || 0;
        if (w > 0 && h > 0) {
          if (typeof fg.width === 'function')  fg.width(w);
          if (typeof fg.height === 'function') fg.height(h);
        }
        // 2. Re-evaluate accessors and queue a real draw call.
        if (typeof fg.refresh === 'function') fg.refresh();
        // 3. Resume the rAF loop in case it was paused by visibility change.
        if (typeof fg.resumeAnimation === 'function') fg.resumeAnimation();
        // 4. NUDGE THE CHROMIUM COMPOSITOR. Even with the canvas resized
        //    correctly, the compositor sometimes keeps presenting the
        //    cached layer until something triggers a recomposite. A
        //    1-frame transform toggle on the host forces the compositor
        //    to re-rasterize this layer cleanly.
        try {
          host.style.transform = 'translateZ(0)';
          requestAnimationFrame(() => {
            try { host.style.transform = ''; } catch (_) {}
          });
        } catch (_) {}
      } catch (_) {}
    }

    function onLost(e) {
      // Default action of webglcontextlost is "context is gone, no recovery
      // ever". We need to call preventDefault to enable
      // webglcontextrestored to fire later.
      try { e.preventDefault(); } catch (_) {}
    }
    function onRestored() {
      // GPU is back. Tell force-graph to rebuild its draw state.
      forceRedraw();
    }
    function onVisible() {
      if (document.visibilityState === 'visible') {
        // Schedule the redraw on the next animation frame so the compositor
        // has finished setting up the new surface before we draw into it.
        try { requestAnimationFrame(forceRedraw); } catch (_) { forceRedraw(); }
      }
    }
    function onFocus() { try { requestAnimationFrame(forceRedraw); } catch (_) { forceRedraw(); } }

    // Wire up.
    handlers.canvases = findCanvas();
    if (mode === '3d') {
      for (const c of handlers.canvases) {
        try { c.addEventListener('webglcontextlost', onLost, false); } catch (_) {}
        try { c.addEventListener('webglcontextrestored', onRestored, false); } catch (_) {}
      }
    }
    handlers.lost = onLost;
    handlers.restored = onRestored;
    handlers.vis = onVisible;
    handlers.focus = onFocus;
    try { document.addEventListener('visibilitychange', onVisible); } catch (_) {}
    try { window.addEventListener('focus', onFocus); } catch (_) {}
    state.fgRecoveryHandlers = handlers;
  }

  function detachGraphRecovery() {
    const h = state.fgRecoveryHandlers;
    if (!h) return;
    if (h.canvases && (h.lost || h.restored)) {
      for (const c of h.canvases) {
        try { c.removeEventListener('webglcontextlost', h.lost, false); } catch (_) {}
        try { c.removeEventListener('webglcontextrestored', h.restored, false); } catch (_) {}
      }
    }
    if (h.vis) { try { document.removeEventListener('visibilitychange', h.vis); } catch (_) {} }
    if (h.focus) { try { window.removeEventListener('focus', h.focus); } catch (_) {} }
    state.fgRecoveryHandlers = null;
  }

  function teardownNetwork() {
    if (state.sigmaLayoutCancel) { try { state.sigmaLayoutCancel(); } catch (_) {} state.sigmaLayoutCancel = null; }
    if (state.fgRevealFallback) { clearTimeout(state.fgRevealFallback); state.fgRevealFallback = null; }
    if (state.fgResizeObserver) { try { state.fgResizeObserver.disconnect(); } catch (_) {} state.fgResizeObserver = null; }
    if (state.fgResizeHandler) { try { window.removeEventListener('resize', state.fgResizeHandler); } catch (_) {} state.fgResizeHandler = null; }
    if (state.fgResizePause) { clearTimeout(state.fgResizePause); state.fgResizePause = null; }
    detachGraphRecovery();
    if (state.fg) {
      try { state.fg.pauseAnimation(); } catch (_) {}
      try {
        // 3d-force-graph mounts inside the host element; clearing it removes
        // the canvas + WebGL context cleanly. Without this, repeated rebuilds
        // would stack canvases and leak GPU memory.
        const host = $('mindCanvasHost');
        if (host) host.innerHTML = '';
      } catch (_) {}
      state.fg = null;
    }
    state.fgStars = null;
    state.glGraph = null;
    state.graphSettled = false;
    state.visNodes = null;
    state.visEdges = null;
    state.network = null;
  }

  function graphHostSize(host) {
    const rect = host && host.getBoundingClientRect ? host.getBoundingClientRect() : {};
    return {
      width: Math.max(1, Math.floor(rect.width || host?.clientWidth || 1)),
      height: Math.max(1, Math.floor(rect.height || host?.clientHeight || 1)),
    };
  }

  function syncGraphSize(fg, host) {
    if (!fg || !host) return { width: 1, height: 1 };
    const size = graphHostSize(host);
    try {
      if (typeof fg.width === 'function' && fg.width() !== size.width) fg.width(size.width);
      if (typeof fg.height === 'function' && fg.height() !== size.height) fg.height(size.height);
    } catch (_) {}
    return size;
  }

  function forceGraphRenderFrame(fg, host) {
    if (!fg) return;
    try { if (host) syncGraphSize(fg, host); } catch (_) {}
    try { fg.resumeAnimation(); } catch (_) {}
    try { if (typeof fg.tickFrame === 'function') fg.tickFrame(); } catch (_) {}
    try {
      const renderer = fg.renderer && fg.renderer();
      const scene = fg.scene && fg.scene();
      const camera = fg.camera && fg.camera();
      if (!renderer || !scene || !camera) return;
      if (typeof renderer.compile === 'function') renderer.compile(scene, camera);
      if (typeof renderer.render === 'function') renderer.render(scene, camera);
    } catch (_) {}
  }

  function waitForGraphPaint(fg, host) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timeout = setTimeout(finish, 1200);
      requestAnimationFrame(() => {
        forceGraphRenderFrame(fg, host);
        requestAnimationFrame(() => {
          forceGraphRenderFrame(fg, host);
          clearTimeout(timeout);
          finish();
        });
      });
    });
  }

  // The right sidebar (mindDetail) covers ~25% of the canvas. zoomToFit
  // centers on the canvas geometric center, which then sits behind the
  // sidebar. After the fit, we pan the camera right so the graph
  // centers in the VISIBLE portion of the canvas (the left ~75%).
  function fitGraph() {
    if (!state.fg) return;
    try {
      state.fg.zoomToFit(600, 80);
      // Pan after fit completes. The sidebar offset = ~25% of width;
      // translating both camera + lookAt by that fraction of the camera-
      // to-target distance moves the visible center accordingly.
      setTimeout(() => panCameraForSidebar(state.fg, 600), 650);
    } catch (_) {}
  }

  // Translate the camera (and its lookAt target) sideways so the graph
  // centers in the visible canvas area instead of behind the sidebar.
  function panCameraForSidebar(fg, durationMs = 0) {
    try {
      const cam = fg.camera();
      if (!cam || !cam.quaternion || !cam.up || !cam.up.constructor) return;
      const Vec3 = cam.up.constructor;
      const rightVec = new Vec3(1, 0, 0).applyQuaternion(cam.quaternion);
      // Offset magnitude scales with camera-to-origin distance so the pan
      // looks consistent regardless of zoom level.
      const dist = Math.hypot(cam.position.x, cam.position.y, cam.position.z) || 200;
      const offset = dist * 0.18;
      // Compute current lookAt - 3d-force-graph stores it on the controls.
      const ctrls = fg.controls && fg.controls();
      const target = ctrls && ctrls.target ? ctrls.target : { x: 0, y: 0, z: 0 };
      const camPos = {
        x: cam.position.x + rightVec.x * offset,
        y: cam.position.y + rightVec.y * offset,
        z: cam.position.z + rightVec.z * offset,
      };
      const lookAt = {
        x: target.x + rightVec.x * offset,
        y: target.y + rightVec.y * offset,
        z: target.z + rightVec.z * offset,
      };
      fg.cameraPosition(camPos, lookAt, durationMs);
    } catch (_) {}
  }

  function paintGraphModeSwitch() {
    const wrap = $('mindModeSwitch');
    if (!wrap) return;
    const active = state.prefs.graphMode === '2d' ? '2d' : '3d';
    const buttons = wrap.querySelectorAll('button[data-mode]');
    buttons.forEach((b) => {
      const isActive = b.getAttribute('data-mode') === active;
      b.style.background = isActive ? 'var(--surface2)' : 'transparent';
      b.style.color = isActive ? 'var(--text)' : 'var(--subtext0)';
      b.style.fontWeight = isActive ? '600' : '400';
    });
  }
  function paintMindmapGate() {
    const btn = $('mindMapGateBtn');
    if (!btn) return;
    btn.textContent = 'Enter Mind Map';
    // If the user already entered the map this session, keep the gate
    // hidden across re-renders. Without this, anything that re-injects
    // the renderGraph DOM (search Go, filter change, mode switch) would
    // resurface the gate even though state.mindmapLoaded is still true.
    const gate = $('mindMapGate');
    if (gate) gate.style.display = state.mindmapLoaded ? 'none' : '';
    // Populate the live stats panel so the gate shows what's actually
    // inside the brain instead of an empty void below the button.
    const stats = $('mindGateStats');
    if (!stats || !state.graph) return;
    const g = state.graph;
    const kindCounts = {};
    let edgeCount = 0;
    for (const n of g.nodes) kindCounts[n.kind] = (kindCounts[n.kind] || 0) + 1;
    edgeCount = g.edges.length;
    const communityCount = g.communities ? Object.keys(g.communities).length : 0;
    // Top-level summary cards.
    const summary = [
      { label: 'Nodes',        value: g.nodes.length },
      { label: 'Connections',  value: edgeCount },
      { label: 'Communities',  value: communityCount },
    ];
    // Sort kinds by count, drop empty, format friendly label.
    const KIND_LABEL = {
      code: 'code', doc: 'docs', note: 'notes',
      conversation: 'AI conversations', drawer: 'CLI messages',
      learning: 'learnings', plugin: 'plugins', recipe: 'recipes',
      workitem: 'work items', concept: 'concepts', tag: 'tags',
      artifact: 'artifacts', paper: 'papers', image: 'images',
    };
    const KIND_COLOR = {
      code: '#a6e3a1', doc: '#94e2d5', note: '#f9e2af',
      conversation: '#cba6f7', drawer: '#b4befe',
      learning: '#fab387', plugin: '#f5c2e7', recipe: '#89dceb',
      workitem: '#f38ba8', concept: '#89b4fa', tag: '#bac2de',
      artifact: '#74c7ec',
    };
    const sortedKinds = Object.entries(kindCounts)
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]);

    const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
    // The marquee needs duplicated content so the loop is seamless. Each
    // pass we render the pill list TWICE side-by-side and animate the
    // outer track by -50% over a duration proportional to the pill count.
    const renderPill = ([kind, count]) => {
      const label = KIND_LABEL[kind] || kind;
      const color = KIND_COLOR[kind] || '#cdd6f4';
      return `<div class="mind-gate-pill" style="display:inline-flex;align-items:center;gap:8px;flex-shrink:0;background:var(--surface1);border:1px solid var(--surface2);border-radius:999px;padding:6px 14px;font-size:11px;color:var(--text);white-space:nowrap;">
        <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;"></span>
        <span style="font-weight:500;">${label}</span>
        <span style="color:var(--subtext0);font-variant-numeric:tabular-nums;">${fmt(count)}</span>
      </div>`;
    };
    const pills = sortedKinds.map(renderPill).join('');
    // 8 seconds per ~6 pills, scaled. Cap so very long lists still cycle in
    // a reasonable time.
    const animSeconds = Math.max(20, Math.min(60, sortedKinds.length * 3));

    stats.style.display = 'block';
    stats.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;">
        ${summary.map(s => `
          <div style="background:var(--surface0);border:1px solid var(--surface1);border-radius:8px;padding:14px 12px;">
            <div style="font-size:22px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;line-height:1.1;">${fmt(s.value)}</div>
            <div style="font-size:10px;color:var(--subtext0);text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">${s.label}</div>
          </div>
        `).join('')}
      </div>
      ${sortedKinds.length ? `
        <div style="text-align:left;background:var(--surface0);border:1px solid var(--surface1);border-radius:8px;padding:14px 0;overflow:hidden;">
          <div style="font-size:10px;color:var(--subtext0);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;padding:0 16px;">What's inside</div>
          <div class="mind-gate-marquee" style="overflow:hidden;mask-image:linear-gradient(90deg,transparent 0,#000 6%,#000 94%,transparent 100%);-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 6%,#000 94%,transparent 100%);">
            <div class="mind-gate-marquee-track" style="display:inline-flex;gap:10px;padding:2px 0;animation:mind-gate-marquee ${animSeconds}s linear infinite;">
              ${pills}
              ${pills}
            </div>
          </div>
        </div>
      ` : ''}
      <style>
        @keyframes mind-gate-marquee {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .mind-gate-marquee:hover .mind-gate-marquee-track { animation-play-state: paused; }
      </style>
    `;
  }
  function loadMindmap() {
    state.mindmapLoaded = true;
    const gate = $('mindMapGate');
    if (gate) gate.style.display = 'none';
    buildNetworkAsync({ loaderText: state.prefs.graphCap === 'all' ? 'Loading full graph...' : 'Laying out graph...' });
  }
  function setGraphMode(mode) {
    const next = mode === '2d' ? '2d' : '3d';
    if (state.prefs.graphMode === next) return;
    state.prefs.graphMode = next;
    savePrefs();
    paintGraphModeSwitch();
    paintMindmapGate();
    // Only rebuild if the user has already entered the map. While the
    // gate is up, the mode switch just relabels the entry button so the
    // user knows which renderer they'll get when they press it.
    if ((state.view === 'graph' || state.view === 'mindmap') && state.mindmapLoaded) {
      buildNetworkAsync({ loaderText: next === '2d' ? 'Switching to 2D...' : 'Switching to 3D...' });
    }
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
          <div class="mind-detail-scroll">
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
          </div>

          <div class="mind-detail-actions">
            <button class="mind-action-btn mind-action-primary" onclick="MindUI.askAbout('${encodeURIComponent(n.label)}')">Ask Mind about this</button>
            <button class="mind-action-btn mind-action-purge" onclick="MindUI.purgeNode('${encodeURIComponent(n.id)}')" title="Delete this node from the graph">Purge</button>
          </div>
        </div>
        <style>
          #mindDetail { padding:0 !important; overflow:hidden !important; }
          .mind-detail { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; }
          .mind-detail-scroll { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; padding:14px; display:flex; flex-direction:column; gap:14px; }
          .mind-detail * { min-width:0; }
          .mind-detail-head { display:flex; align-items:flex-start; gap:8px; padding-bottom:10px; border-bottom:1px solid var(--surface0); }
          .mind-detail-title { flex:1; display:flex; align-items:flex-start; gap:8px; min-width:0; }
          .mind-detail-kind-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; margin-top:5px; }
          .mind-detail-label { font-size:13px; font-weight:600; color:var(--text); line-height:1.35; word-break:break-word; overflow-wrap:anywhere; }
          .mind-detail-close { padding:0 8px; font-size:14px; line-height:1; flex-shrink:0; }
          .mind-chip-row { display:flex; flex-wrap:wrap; gap:4px; }
          .mind-chip { font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; padding:2px 7px; border-radius:10px; }
          .mind-chip-link:hover { filter:brightness(1.3); }
          .mind-chip-tag { background:var(--surface0); color:var(--subtext0); font-weight:500; text-transform:none; letter-spacing:0; }
          .mind-detail-meta { display:grid; grid-template-columns:auto minmax(0, 1fr); column-gap:10px; row-gap:5px; font-size:11px; }
          .mind-meta-key { color:var(--subtext0); text-transform:uppercase; font-size:9.5px; letter-spacing:0.5px; padding-top:2px; }
          .mind-meta-val { color:var(--text); word-break:break-all; overflow-wrap:anywhere; min-width:0; }
          .mind-meta-val-mono { font-family:var(--font-mono, monospace); font-size:10px; color:var(--subtext1); overflow-wrap:anywhere; word-break:break-all; }
          .mind-id { font-family:var(--font-mono, monospace); font-size:10px; background:var(--surface0); color:var(--subtext1); padding:1px 5px; border-radius:3px; word-break:break-all; overflow-wrap:anywhere; max-width:100%; display:inline-block; }
          .mind-path { font-family:var(--font-mono, monospace); font-size:10px; color:var(--text); background:var(--surface0); padding:2px 5px; border-radius:3px; display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom; }
          .mind-detail-section { display:flex; flex-direction:column; gap:6px; }
          .mind-detail-section-title { font-size:10px; font-weight:700; color:var(--subtext0); text-transform:uppercase; letter-spacing:0.6px; display:flex; align-items:center; gap:6px; }
          .mind-section-count { background:var(--surface0); color:var(--subtext0); padding:0 6px; border-radius:8px; font-weight:500; font-size:9.5px; }
          .mind-detail-prose { font-size:11px; color:var(--text); background:var(--base); padding:8px 10px; border-radius:4px; line-height:1.5; max-height:200px; overflow-y:auto; overflow-x:hidden; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
          .mind-empty { font-size:11px; color:var(--subtext0); font-style:italic; padding:6px; }
          .mind-neighbors { display:flex; flex-direction:column; gap:3px; max-height:280px; overflow-y:auto; overflow-x:hidden; padding-right:2px; }
          .mind-nb-row { display:flex; align-items:center; gap:6px; padding:5px 8px; background:var(--base); border-radius:3px; font-size:11px; color:var(--text); text-decoration:none; cursor:pointer; transition:background 0.1s; border-left:2px solid transparent; min-width:0; }
          .mind-nb-row:hover { background:var(--surface0); border-left-color:var(--accent); }
          .mind-nb-arrow { color:var(--subtext0); font-size:11px; min-width:14px; text-align:center; flex-shrink:0; }
          .mind-nb-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .mind-nb-rel { color:var(--subtext0); font-size:10px; padding:1px 5px; background:var(--surface0); border-radius:3px; flex-shrink:0; }
          .mind-nb-conf { font-size:9px; font-weight:700; min-width:10px; text-align:center; flex-shrink:0; }
          .mind-detail-actions { display:flex; gap:8px; padding:12px 14px; border-top:1px solid var(--surface0); background:var(--mantle); flex-shrink:0; }
          .mind-action-btn { font-size:13px; font-weight:600; padding:11px 16px; border-radius:6px; border:1px solid var(--surface1); background:var(--surface0); color:var(--text); cursor:pointer; line-height:1; transition:background 0.12s, border-color 0.12s; }
          .mind-action-btn:hover { background:var(--surface1); border-color:var(--surface2); }
          .mind-action-primary { flex:1; }
          .mind-action-purge { color:var(--red); padding-left:14px; padding-right:14px; }
          .mind-action-purge:hover { background:var(--red); color:var(--mantle); border-color:var(--red); }
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
      const diff = Date.now() - d.getTime();
      const rel = formatRelativeMs(diff);
      if (rel) return rel;
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return iso; }
  }
  // Smart relative-time formatter: rolls minutes -> hours -> days -> weeks
  // -> months -> years so we never show "900m ago" again.
  function formatRelativeMs(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms < 0) ms = 0;
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
    if (ms < 604800000) return Math.round(ms / 86400000) + 'd ago';
    if (ms < 2592000000) return Math.round(ms / 604800000) + 'w ago';
    if (ms < 31557600000) return Math.round(ms / 2592000000) + 'mo ago';
    return Math.round(ms / 31557600000) + 'y ago';
  }

  // GPU / WebGL diagnostic — opens an alert dialog showing the renderer
  // strings the browser actually sees. If the user expected hardware
  // acceleration but the renderer reports 'SwiftShader' or 'Software'
  // that's the smoking gun: Chromium fell back to software rendering.
  function showGpuInfo() {
    const lines = [];
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) {
        lines.push('FAIL: WebGL is NOT available in this Electron window.');
        lines.push('The 3D graph cannot use the GPU; everything will fall back to software.');
      } else {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const vendor   = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext);
        const isSoftware = /(SwiftShader|llvmpipe|Microsoft Basic|Software)/i.test(renderer);
        lines.push('WebGL version : ' + (isWebGL2 ? 'WebGL 2 (best)' : 'WebGL 1 (fallback)'));
        lines.push('Vendor        : ' + vendor);
        lines.push('Renderer      : ' + renderer);
        lines.push('Max texture   : ' + gl.getParameter(gl.MAX_TEXTURE_SIZE));
        lines.push('');
        if (isSoftware) {
          lines.push('WARNING: Renderer string suggests SOFTWARE rendering.');
          lines.push('Hardware acceleration was requested but Chromium fell back.');
          lines.push('Update your GPU driver, or check for an enterprise policy that disables GPU.');
        } else {
          lines.push('Hardware GPU is being used — graph rendering should be fast.');
        }
      }
    } catch (e) {
      lines.push('Probe failed: ' + (e.message || String(e)));
    }
    alert(lines.join('\n'));
  }

  window.MindUI = { onActivate, onDeactivate, setView, build, update, toggleWatch, askAbout, purgeNode, closeDetail, fitGraph, setGraphMode, loadMindmap, clearSearch, runSearch, toggleSearchOnly, showGpuInfo,
    deselectNode: () => { if (state.fgClearHighlight) state.fgClearHighlight(); },
    showConnected: () => { if (state.fgShowConnected) state.fgShowConnected(); },
    refreshLock, refreshQuality,
    _wakeupRefresh: refreshWakeupOutput,
    _queryRun: runQueryFromUi,
    _smartRun: runSmart,
    _embedAll: embedAll,
    _artifactsCreate: artifactsCreate,
    _wakeupOpen: () => { state.view = 'dashboard'; renderWakeup(); },
    _healthCheck: async () => {
      const el = document.getElementById('mindDiagOut');
      if (!el) return;
      el.textContent = 'checking...';
      try {
        const h = await API('/api/mind/health');
        const e = h.embeddings || {}; const v = h.vectors || {};
        const embedText = e.ok ? `embed:ok(${e.provider || '?'},${e.dimensions || '?'}d)` : 'embed:not configured';
        el.textContent = `${embedText} · vectors:${v.count || 0}/${v.dim || 0}d`;
      } catch (err) { el.textContent = 'error: ' + (err.message || err); }
    },
  };
})();
