// mind-ui :: dashboard module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, API, state } from './core.js';
import { build, showCommunityDetail, showNodeDetail } from './detailActions.js';
import { communityColor } from './graph.js';
import { escapeHtml, formatRelativeMs, nodeLabel } from './helpers.js';

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

export { barChart, cliColor, communityCard, communityRow, contributorRow, convRow, donut, godRow, legendItem, refreshCliCoverage, renderCommunities, renderDashboard, renderHotspots, renderSearchResultsPanel, statCard, surpriseRow };
