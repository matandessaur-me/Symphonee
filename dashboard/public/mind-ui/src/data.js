// mind-ui :: data module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, API, state } from './core.js';
import { refreshLock } from './detailActions.js';
import { formatRelativeMs } from './helpers.js';
import { render } from './router.js';
import { refreshSmartHealth } from './views.js';

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
      const LAYOUT_VERSION = 'v4-no-partial-cache';
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
      // PARTIAL-LAYOUT GUARD. When the user is searching (or 'searchOnly'
      // is on) we render only a subset of nodes. Saving that subset's
      // positions would poison the cache — next full-graph render would
      // pin those few nodes and Fibonacci-spiral the rest, producing the
      // hairball the user reported. Only persist when we have positions
      // for at least 90% of the total graph nodes.
      const totalNodes = (state.graph && state.graph.nodes && state.graph.nodes.length) || 0;
      if (totalNodes && data.nodes.length < totalNodes * 0.9) {
        return;
      }
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

  // Treat a cache as a hit ONLY if it covers the full node set (>=90%).
  // A partial cache (e.g. one written before this guard existed, or an
  // earlier corrupted save) would otherwise pin a few nodes and leave
  // the rest at default positions — that's how the hairball got cached.
  function cacheCoversFullGraph(cachedPositions) {
    if (!cachedPositions) return false;
    const totalNodes = (state.graph && state.graph.nodes && state.graph.nodes.length) || 0;
    if (!totalNodes) return false;
    const coverage = Object.keys(cachedPositions).length / totalNodes;
    return coverage >= 0.9;
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

export { cacheCoversFullGraph, computeNodeHash, connectWS, focusGraphNode, hideGraphLoader, loadGraph, onMindUpdate, persistLayout, refreshQuality, refreshStatus, setStatus, setWatch, showGraphLoader };
