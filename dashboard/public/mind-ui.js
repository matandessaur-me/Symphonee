/**
 * Mind tab UI.
 *
 * Three views over the same graph:
 *   - communities: card grid, each card is one community with cohesion + top gods
 *   - hotspots:    god nodes ranked + surprises ranked (the "what should I look at?" view)
 *   - graph:       interactive force-directed graph canvas, capped at ~5000 nodes
 *
 * Side panel on the right shows full node detail when a node is clicked.
 *
 * No external graph library required - the canvas view uses a tiny built-in
 * force layout. Sufficient for showing the brain at human-comprehensible
 * scale; for full graphify-grade rendering, swap in vis-network later.
 */

(function () {
  const API = (path, opts = {}) => fetch(path, opts).then(r => r.json());
  const $ = (id) => document.getElementById(id);

  let state = {
    view: 'communities',
    graph: null,
    selectedNode: null,
    watchEnabled: false,
    canvas: null,
    canvasCtx: null,
    layout: null,
    rafId: null,
    transform: { x: 0, y: 0, k: 1 },
    drag: null,
    ws: null,
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  function onActivate() {
    refreshStatus();
    loadGraph().then(render);
    if (!state.ws) connectWS();
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
      loadGraph().then(render);
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

  function setStatus(msg) { const el = $('mindStatusLine'); if (el) el.textContent = msg; }
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
    cancelLayout();
    if (!state.graph) {
      $('mindMain').innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--subtext0);">
          <div style="font-size:14px;margin-bottom:8px;color:var(--text);">No brain yet for this space.</div>
          <div style="font-size:12px;margin-bottom:16px;">Run a build to ingest your notes, learnings, CLI memory, recipes, plugins, instructions, and active repo code.</div>
          <button class="tab-bar-btn" onclick="MindUI.build()" style="padding:6px 14px;font-size:12px;">Build the brain</button>
        </div>`;
      return;
    }
    if (state.view === 'communities') renderCommunities();
    else if (state.view === 'hotspots') renderHotspots();
    else if (state.view === 'graph') renderGraph();
  }

  function renderCommunities() {
    const g = state.graph;
    const cards = Object.entries(g.communities || {})
      .map(([cid, c]) => ({ cid, ...c }))
      .sort((a, b) => b.size - a.size);
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
    const gods = g.gods || [];
    const surprises = g.surprises || [];
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

  // ── Graph canvas (force-directed) ───────────────────────────────────────────
  function renderGraph() {
    const g = state.graph;
    const main = $('mindMain');
    main.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <div style="font-size:11px;color:var(--subtext0);">Drag nodes. Scroll to zoom. Solid = EXTRACTED, dashed = INFERRED, dotted = AMBIGUOUS.</div>
        <span style="flex:1;"></span>
        <select id="mindGraphFilter" style="background:var(--surface0);color:var(--text);border:1px solid var(--surface1);border-radius:4px;padding:3px 6px;font-size:11px;">
          <option value="all">All node kinds</option>
          <option value="code">code only</option>
          <option value="doc">docs only</option>
          <option value="note">notes only</option>
          <option value="concept">concepts only</option>
        </select>
      </div>
      <canvas id="mindCanvas" width="800" height="560" style="border:1px solid var(--surface1);background:var(--mantle);width:100%;height:560px;border-radius:4px;"></canvas>`;
    const canvas = $('mindCanvas');
    state.canvas = canvas;
    state.canvasCtx = canvas.getContext('2d');
    sizeCanvas();
    initLayout(g);
    attachCanvasEvents();
    $('mindGraphFilter').addEventListener('change', () => { initLayout(g); });
    runLayoutLoop();
  }

  function sizeCanvas() {
    const c = state.canvas; if (!c) return;
    const rect = c.getBoundingClientRect();
    c.width = Math.max(400, Math.floor(rect.width));
    c.height = Math.max(300, Math.floor(rect.height));
  }

  function initLayout(g) {
    const filter = $('mindGraphFilter')?.value || 'all';
    let nodes = g.nodes;
    if (filter !== 'all') nodes = nodes.filter(n => n.kind === filter);
    if (nodes.length > 1500) nodes = topByDegree(nodes, g.edges, 1500);
    const idSet = new Set(nodes.map(n => n.id));
    const edges = g.edges.filter(e => idSet.has(e.source) && idSet.has(e.target));

    const w = state.canvas.width, h = state.canvas.height;
    const layout = {
      nodes: nodes.map(n => ({
        id: n.id, label: n.label, kind: n.kind, communityId: n.communityId,
        x: w / 2 + (Math.random() - 0.5) * 200,
        y: h / 2 + (Math.random() - 0.5) * 200,
        vx: 0, vy: 0,
        radius: nodeRadius(n),
        color: nodeColor(n),
      })),
      edges: edges.map(e => ({ source: e.source, target: e.target, confidence: e.confidence, relation: e.relation })),
      idIndex: new Map(),
      iter: 0,
    };
    layout.nodes.forEach((n, i) => layout.idIndex.set(n.id, i));
    state.layout = layout;
    state.transform = { x: 0, y: 0, k: 1 };
  }

  function topByDegree(nodes, edges, k) {
    const deg = new Map();
    for (const e of edges) {
      deg.set(e.source, (deg.get(e.source) || 0) + 1);
      deg.set(e.target, (deg.get(e.target) || 0) + 1);
    }
    return nodes.slice().sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0)).slice(0, k);
  }

  function nodeRadius(n) {
    if (n.kind === 'code') return 4;
    if (n.kind === 'doc') return 5;
    if (n.kind === 'note') return 6;
    if (n.kind === 'plugin') return 7;
    if (n.kind === 'tag') return 3;
    return 5;
  }

  // 12 community palette - readable on dark bg
  const PALETTE = ['#89b4fa', '#f38ba8', '#a6e3a1', '#fab387', '#cba6f7', '#94e2d5', '#f9e2af', '#74c7ec', '#eba0ac', '#b4befe', '#f5c2e7', '#89dceb'];
  function nodeColor(n) {
    if (typeof n.communityId === 'number') return PALETTE[n.communityId % PALETTE.length];
    return '#9399b2';
  }

  function runLayoutLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    const tick = () => {
      const L = state.layout; if (!L) return;
      stepLayout(L);
      drawGraph();
      L.iter++;
      if (L.iter < 600) state.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);
  }

  function cancelLayout() {
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    state.layout = null;
  }

  function stepLayout(L) {
    const w = state.canvas.width, h = state.canvas.height;
    const nodes = L.nodes; const edges = L.edges;
    // Repulsion (Barnes-Hut would be better, this is O(n^2) but capped at 1500)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist2 = dx * dx + dy * dy + 0.01;
        const force = 350 / dist2;
        const fx = dx * force, fy = dy * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // Spring forces along edges
    for (const e of edges) {
      const ai = L.idIndex.get(e.source); const bi = L.idIndex.get(e.target);
      const a = nodes[ai], b = nodes[bi];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist - 60) * 0.04;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // Center gravity + damping + integrate
    const cx = w / 2, cy = h / 2;
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.005;
      n.vy += (cy - n.y) * 0.005;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
    }
  }

  function drawGraph() {
    const ctx = state.canvasCtx; const c = state.canvas;
    if (!ctx || !c || !state.layout) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.translate(state.transform.x, state.transform.y);
    ctx.scale(state.transform.k, state.transform.k);
    // Edges first
    for (const e of state.layout.edges) {
      const ai = state.layout.idIndex.get(e.source); const bi = state.layout.idIndex.get(e.target);
      const a = state.layout.nodes[ai], b = state.layout.nodes[bi];
      ctx.beginPath();
      if (e.confidence === 'EXTRACTED') { ctx.strokeStyle = 'rgba(180,190,254,0.35)'; ctx.setLineDash([]); }
      else if (e.confidence === 'INFERRED') { ctx.strokeStyle = 'rgba(245,194,231,0.35)'; ctx.setLineDash([4, 3]); }
      else { ctx.strokeStyle = 'rgba(243,139,168,0.5)'; ctx.setLineDash([2, 3]); }
      ctx.lineWidth = 0.7;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Nodes
    for (const n of state.layout.nodes) {
      ctx.beginPath();
      ctx.fillStyle = n.color;
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fill();
      if (state.selectedNode === n.id) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    ctx.restore();
  }

  function attachCanvasEvents() {
    const c = state.canvas; if (!c) return;
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      const rect = c.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      state.transform.x = mx - (mx - state.transform.x) * factor;
      state.transform.y = my - (my - state.transform.y) * factor;
      state.transform.k *= factor;
      drawGraph();
    }, { passive: false });
    c.addEventListener('mousedown', (ev) => {
      const rect = c.getBoundingClientRect();
      const x = (ev.clientX - rect.left - state.transform.x) / state.transform.k;
      const y = (ev.clientY - rect.top - state.transform.y) / state.transform.k;
      const hit = pickNode(x, y);
      if (hit) {
        state.drag = { id: hit.id, hit };
        state.selectedNode = hit.id;
        showNodeDetail(hit.id);
      } else {
        state.drag = { pan: true, sx: ev.clientX, sy: ev.clientY, ox: state.transform.x, oy: state.transform.y };
      }
    });
    c.addEventListener('mousemove', (ev) => {
      if (!state.drag) return;
      if (state.drag.pan) {
        state.transform.x = state.drag.ox + (ev.clientX - state.drag.sx);
        state.transform.y = state.drag.oy + (ev.clientY - state.drag.sy);
        drawGraph();
        return;
      }
      const rect = c.getBoundingClientRect();
      const x = (ev.clientX - rect.left - state.transform.x) / state.transform.k;
      const y = (ev.clientY - rect.top - state.transform.y) / state.transform.k;
      state.drag.hit.x = x; state.drag.hit.y = y;
      state.drag.hit.vx = 0; state.drag.hit.vy = 0;
    });
    c.addEventListener('mouseup', () => { state.drag = null; });
    c.addEventListener('mouseleave', () => { state.drag = null; });
  }

  function pickNode(x, y) {
    if (!state.layout) return null;
    for (let i = state.layout.nodes.length - 1; i >= 0; i--) {
      const n = state.layout.nodes[i];
      const dx = x - n.x, dy = y - n.y;
      if (dx * dx + dy * dy <= (n.radius + 3) * (n.radius + 3)) return n;
    }
    return null;
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
      detail.innerHTML = `
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px;">
          <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(n.label)}</div>
          <span style="flex:1;"></span>
          <button class="tab-bar-btn" onclick="MindUI.closeDetail()" title="Close">×</button>
        </div>
        <div style="font-size:11px;color:var(--subtext0);margin-bottom:10px;">
          <div><b style="color:var(--subtext1);">id</b> <code style="color:var(--text);">${escapeHtml(n.id)}</code></div>
          <div><b style="color:var(--subtext1);">kind</b> ${escapeHtml(n.kind)}</div>
          ${n.source ? `<div><b style="color:var(--subtext1);">source</b> ${escapeHtml(JSON.stringify(n.source))}</div>` : ''}
          ${n.sourceLocation ? `<div><b style="color:var(--subtext1);">location</b> ${escapeHtml(JSON.stringify(n.sourceLocation))}</div>` : ''}
          <div><b style="color:var(--subtext1);">created by</b> ${escapeHtml(n.createdBy || '?')}</div>
          <div><b style="color:var(--subtext1);">created at</b> ${escapeHtml(n.createdAt || '?')}</div>
          ${n.tags && n.tags.length ? `<div><b style="color:var(--subtext1);">tags</b> ${n.tags.map(t => escapeHtml(t)).join(', ')}</div>` : ''}
          ${n.communityId != null ? `<div><b style="color:var(--subtext1);">community</b> #${n.communityId}</div>` : ''}
          ${n.detail ? `<div style="margin-top:6px;color:var(--text);"><b style="color:var(--subtext1);">detail</b><br>${escapeHtml(n.detail)}</div>` : ''}
          ${n.answer ? `<div style="margin-top:6px;color:var(--text);"><b style="color:var(--subtext1);">answer</b><br>${escapeHtml(n.answer)}</div>` : ''}
        </div>
        <div style="font-size:11px;font-weight:600;color:var(--subtext0);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Neighbors (${neighbors.length})</div>
        <div style="display:flex;flex-direction:column;gap:3px;">
          ${neighbors.slice(0, 60).map(nb => `
            <a href="#" class="mind-neighbor-link" data-id="${nb.peer?.id || ''}" style="display:flex;align-items:baseline;gap:6px;padding:4px 6px;background:var(--base);border-radius:3px;text-decoration:none;font-size:11px;color:var(--text);">
              <span style="color:var(--subtext0);min-width:18px;">${nb.direction === 'out' ? '→' : '←'}</span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(nb.peer?.label || nb.edge.target)}</span>
              <span style="color:var(--subtext0);font-size:10px;">${escapeHtml(nb.edge.relation)}</span>
              <span style="color:${confColor(nb.edge.confidence)};font-size:9px;">${nb.edge.confidence[0]}</span>
            </a>`).join('')}
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button class="tab-bar-btn" onclick="MindUI.askAbout('${encodeURIComponent(n.label)}')" style="flex:1;font-size:11px;">Ask Mind about this</button>
          <button class="tab-bar-btn" onclick="MindUI.purgeNode('${encodeURIComponent(n.id)}')" style="font-size:11px;color:var(--red);" title="Delete this node from the graph">Purge</button>
        </div>`;
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

  window.MindUI = { onActivate, setView, build, update, toggleWatch, askAbout, purgeNode, closeDetail };
})();
