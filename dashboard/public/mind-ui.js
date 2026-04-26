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

  let state = {
    view: 'dashboard',
    graph: null,
    selectedNode: null,
    watchEnabled: false,
    network: null,         // vis.Network instance
    visNodes: null,        // vis.DataSet for nodes
    visEdges: null,        // vis.DataSet for edges
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
    teardownNetwork();
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
        .mind-stat-strip { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; }
        .mind-stat-card { background:var(--mantle); border:1px solid var(--surface1); border-radius:6px; padding:10px 12px; display:flex; flex-direction:column; gap:2px; border-left-width:3px; }
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
        .mind-feed-row { padding:7px 9px; background:var(--base); border-radius:4px; border-left:3px solid var(--surface2); cursor:pointer; transition: background 0.1s; }
        .mind-feed-row:hover { background:var(--surface0); }
        .mind-feed-row .mind-feed-meta { display:flex; align-items:center; gap:8px; font-size:10px; color:var(--subtext0); margin-bottom:3px; }
        .mind-feed-row .mind-cli-badge { padding:1px 6px; border-radius:8px; font-size:9px; font-weight:600; text-transform:uppercase; }
        .mind-feed-row .mind-feed-text { font-size:11px; color:var(--text); overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
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
    return `<div class="mind-stat-card" style="border-left-color:${color}"><div class="mind-stat-label">${escapeHtml(label)}</div><div class="mind-stat-value" style="color:${color}">${escapeHtml(String(value))}</div>${hint ? `<div class="mind-stat-hint">${escapeHtml(hint)}</div>` : ''}</div>`;
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
    return `<div class="mind-feed-row" data-id="${escapeHtml(n.id)}" style="border-left-color:${color};">
      <div class="mind-feed-meta"><span class="mind-cli-badge" style="background:${color};color:#1e1e2e;">${escapeHtml(cli)}</span><span>${escapeHtml(date)}</span>${tags}</div>
      <div class="mind-feed-text">${escapeHtml(n.preview || n.label)}</div>
    </div>`;
  }

  function surpriseRow(g, s) {
    return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;padding:5px 8px;background:var(--base);border-radius:4px;">
      <a href="#" data-id="${escapeHtml(s.source)}" style="color:var(--accent);text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%;">${escapeHtml(nodeLabel(g, s.source))}</a>
      <span style="color:var(--subtext0);font-size:10px;">${escapeHtml(s.relation)}</span>
      <a href="#" data-id="${escapeHtml(s.target)}" style="color:var(--accent);text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%;">${escapeHtml(nodeLabel(g, s.target))}</a>
      <span style="color:var(--subtext0);font-size:9px;flex-shrink:0;">c${s.crossesCommunities.join('/')}</span>
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
      <div style="font-size:11px;color:var(--subtext0);margin-bottom:8px;">
        Each circle is a community. Edges show cross-community bridges (sized by traffic). Click a circle to drill in.
      </div>
      <div id="mindCanvasHost" style="width:100%;height:600px;border:1px solid var(--surface1);background:var(--mantle);border-radius:4px;"></div>`;

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

    const nodes = cIds.map(cid => {
      const c = communities[cid];
      return {
        id: 'c' + cid,
        label: `#${cid}\n${c.label.slice(0, 28)}`,
        title: `${c.label}\n${c.size} nodes - cohesion ${Math.round((c.cohesion || 0) * 100)}%`,
        shape: 'dot',
        size: Math.min(70, Math.max(15, 15 + Math.sqrt(c.size) * 4)),
        color: { background: communityColor(parseInt(cid, 10)), border: communityColor(parseInt(cid, 10)), highlight: { background: '#fff', border: communityColor(parseInt(cid, 10)) } },
        font: { color: '#cdd6f4', size: 10, face: 'monospace', strokeWidth: 0, multi: true },
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
      try { state.network.setOptions({ physics: { stabilization: { enabled: false } } }); } catch (_) {}
    });
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

  // ── Graph view (vis-network) ───────────────────────────────────────────────
  function renderGraph() {
    const main = $('mindMain');
    if (typeof window.vis === 'undefined') {
      main.innerHTML = `<div style="padding:20px;color:var(--red);">vis-network failed to load. Check that /vis-network.min.js is reachable.</div>`;
      return;
    }
    main.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
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
        <select id="mindGraphCap" style="background:var(--surface0);color:var(--text);border:1px solid var(--surface1);border-radius:4px;padding:3px 6px;font-size:11px;" title="Cap node count to keep layout fast">
          <option value="500">top 500</option>
          <option value="1000" selected>top 1000</option>
          <option value="2000">top 2000</option>
          <option value="5000">top 5000</option>
        </select>
        <button class="tab-bar-btn" onclick="MindUI.fitGraph()" style="font-size:11px;" title="Fit graph to view">Fit</button>
        <button class="tab-bar-btn" onclick="MindUI.togglePhysics()" id="mindPhysicsBtn" style="font-size:11px;" title="Pause/resume layout physics">Freeze</button>
      </div>
      <div id="mindCanvasHost" style="width:100%;height:600px;border:1px solid var(--surface1);background:var(--mantle);border-radius:4px;"></div>`;

    buildNetwork();
    $('mindGraphFilter').addEventListener('change', buildNetwork);
    $('mindGraphCap').addEventListener('change', buildNetwork);
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
    const cap = parseInt($('mindGraphCap')?.value || '1000', 10);

    let nodes = g.nodes;
    if (filter !== 'all') nodes = nodes.filter(n => n.kind === filter);

    // Compute degree for sizing AND for top-N filtering at the cap.
    const degree = new Map();
    for (const e of g.edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    if (nodes.length > cap) {
      nodes = nodes.slice().sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, cap);
    }
    const idSet = new Set(nodes.map(n => n.id));
    const edges = g.edges.filter(e => idSet.has(e.source) && idSet.has(e.target));

    const visNodes = nodes.map(n => {
      const color = communityColor(n.communityId);
      return {
        id: n.id,
        label: n.label.length > 36 ? n.label.slice(0, 33) + '...' : n.label,
        title: `${n.label}\nkind: ${n.kind}\ncommunity: ${n.communityId ?? '-'}\nid: ${n.id}`,
        shape: KIND_SHAPE[n.kind] || 'dot',
        size: nodeSize(degree.get(n.id) || 0),
        color: { background: color, border: color, highlight: { background: '#fff', border: color } },
        font: { color: '#cdd6f4', size: 11, face: 'monospace', strokeWidth: 0 },
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
      // the whole graph re-flowing on every click.
      try { state.network.setOptions({ physics: { stabilization: { enabled: false } } }); } catch (_) {}
    });
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
    state.network.setOptions({ physics: { enabled: !cur } });
    const btn = $('mindPhysicsBtn'); if (btn) btn.textContent = cur ? 'Resume' : 'Freeze';
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

  window.MindUI = { onActivate, setView, build, update, toggleWatch, askAbout, purgeNode, closeDetail, fitGraph, togglePhysics };
})();
