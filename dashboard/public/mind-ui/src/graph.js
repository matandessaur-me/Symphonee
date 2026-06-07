// mind-ui :: graph module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, API, savePrefs, state } from './core.js';
import { cacheCoversFullGraph, focusGraphNode, hideGraphLoader, persistLayout, showGraphLoader } from './data.js';
import { build, showNodeDetail, update } from './detailActions.js';
import { escapeHtml, nodeLabel } from './helpers.js';
import { render } from './router.js';

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
    // searchOnly is now always true — the toggle button was removed. We
    // still gate on state.search + state.matches so an empty search
    // shows everything.
    if (state.search && state.matches.length) {
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
    const cached3dRaw = (state.prefs.graphMode !== '2d' && state.layoutCache && state.layoutCache['3d']) || null;
    const cached3d = cacheCoversFullGraph(cached3dRaw) ? cached3dRaw : null;
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
      const cached2dRaw = (state.layoutCache && state.layoutCache['2d']) || null;
      const cached2d = cacheCoversFullGraph(cached2dRaw) ? cached2dRaw : null;
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

          // Soft radial cap. forceCenter only shifts the mean of all
          // positions — orphan / low-degree nodes that get pushed by
          // charge with no link to pull them back drift forever, ending
          // up as tiny dots far from the cluster (zoomToFit then shrinks
          // the whole graph to fit them). This force gently pulls any
          // node BACK if it ventures past MAX_RADIUS, doesn't touch
          // nodes inside the cluster.
          const MAX_RADIUS = 2400;
          const radialCap = (function() {
            let n2dNodes;
            function force(alpha) {
              if (!n2dNodes || !n2dNodes.length) return;
              const k = 0.12 * alpha;
              for (let i = 0; i < n2dNodes.length; i++) {
                const node = n2dNodes[i];
                const x = node.x || 0;
                const y = node.y || 0;
                const r = Math.sqrt(x * x + y * y);
                if (r <= MAX_RADIUS) continue;
                // Pull back toward the cap. Strength scales with how far
                // beyond the cap the node is, so the further it drifts
                // the harder it gets pulled.
                const overshoot = (r - MAX_RADIUS) / r;
                node.vx = (node.vx || 0) - x * overshoot * k;
                node.vy = (node.vy || 0) - y * overshoot * k;
              }
            }
            force.initialize = (n) => { n2dNodes = n; };
            return force;
          })();
          fg2.d3Force('radialCap', radialCap);
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

export { KIND_COLOR, KIND_SHAPE, NEUTRAL, NEUTRAL_HUB, PALETTE, attachGraphRecovery, buildNetwork, buildNetworkAsync, communityColor, detachGraphRecovery, fitGraph, forceGraphRenderFrame, graphHostSize, hexToRgba, kindColor, loadMindmap, nodeSize, paintGraphModeSwitch, paintMindmapGate, panCameraForSidebar, renderGraph, setGraphMode, shadeHex, syncGraphSize, teardownNetwork, waitForGraphPaint };
