// mind-ui :: detailActions module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, API, state } from './core.js';
import { cliColor } from './dashboard.js';
import { loadGraph, setStatus, setWatch } from './data.js';
import { communityColor, kindColor } from './graph.js';
import { escapeHtml, formatTimestamp, metaRow, neighborRow, renderLocation, renderSource } from './helpers.js';
import { render } from './router.js';

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
    // Ground the answer on the actual clicked node (set by showNodeDetail), not a
    // re-search of its label -- this is what makes the answer specific instead of
    // the vague "the context does not contain..." we used to get.
    const nodeId = state.selectedNode || null;
    const askQuestion = nodeId
      ? `In one short paragraph, explain what "${q}" is in my work and how it connects to the related items. Be concrete and specific; do not say the context is insufficient.`
      : q;
    const detail = $('mindDetail');
    detail.style.display = 'block';
    detail.innerHTML = `
      <div style="padding:16px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(q)}</div>
        <div class="mind-ask-loading">Asking Mind<span>.</span><span>.</span><span>.</span></div>
      </div>
      <style>
        .mind-ask-loading { font-size:11px; color:var(--subtext0); }
        .mind-ask-loading span { animation: maskdot 1.2s infinite; opacity:0.3; }
        .mind-ask-loading span:nth-child(2){ animation-delay:0.2s; }
        .mind-ask-loading span:nth-child(3){ animation-delay:0.4s; }
        @keyframes maskdot { 0%,80%,100%{opacity:0.25;} 40%{opacity:1;} }
      </style>`;
    // Lead with a real written answer from the local model (Gemma/Qwen) grounded
    // in the graph; fetch the raw sub-graph in parallel and tuck it away as
    // "related knowledge" -- useful for the AI / drill-down, but secondary to the
    // human-readable explanation the user actually wants.
    let ans = null, sub = null;
    try {
      [ans, sub] = await Promise.all([
        API('/api/mind/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: askQuestion, nodeId }) }).catch(() => null),
        API('/api/mind/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, budget: 1200 }) }).catch(() => null),
      ]);
    } catch (_) {}
    const answerText = (ans && ans.ok && ans.answer) ? ans.answer : '';
    const subNodes = (sub && sub.nodes) || [];
    const noModel = ans && ans.reason === 'no-local-model';
    const emptyMsg = noModel
      ? 'No local chat model is running. Start Ollama with a model like gemma or qwen to get a written answer; the related knowledge below is still available.'
      : 'Could not generate a written answer right now. The related knowledge below is what Mind knows about this.';

    detail.innerHTML = `
      <div class="mind-ask">
        <div class="mind-ask-scroll">
          <div class="mind-ask-q">${escapeHtml(q)}</div>
          ${answerText
            ? `<div class="mind-ask-answer">${escapeHtml(answerText)}</div>
               <div class="mind-ask-model">answered locally by ${escapeHtml(ans.model || 'local model')}${ans.grounded ? ' &middot; grounded in ' + ans.grounded + ' knowledge node' + (ans.grounded === 1 ? '' : 's') : ''}</div>`
            : `<div class="mind-ask-empty">${escapeHtml(emptyMsg)}</div>`}
          ${subNodes.length ? `
            <details class="mind-ask-graph" ${answerText ? '' : 'open'}>
              <summary>Related knowledge <span class="mind-section-count">${subNodes.length}</span></summary>
              <div class="mind-ask-nodes">
                ${subNodes.slice(0, 50).map(n => `<a href="#" class="mind-neighbor-link" data-id="${escapeHtml(n.id)}">${escapeHtml(n.label)} <span class="mind-ask-kind">(${escapeHtml(n.kind)})</span></a>`).join('')}
              </div>
            </details>` : ''}
        </div>
        <div class="mind-detail-actions">
          <button class="mind-action-btn mind-action-primary" onclick="MindUI.closeDetail()">Close</button>
        </div>
      </div>
      <style>
        #mindDetail { padding:0 !important; overflow:hidden !important; }
        .mind-ask { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; }
        .mind-ask-scroll { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; padding:16px; display:flex; flex-direction:column; gap:12px; }
        .mind-ask-q { font-size:13px; font-weight:600; color:var(--text); line-height:1.35; word-break:break-word; }
        .mind-ask-answer { font-size:12.5px; color:var(--text); line-height:1.6; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; background:var(--base); padding:12px 14px; border-radius:6px; border-left:2px solid var(--accent); }
        .mind-ask-model { font-size:10px; color:var(--subtext0); font-style:italic; }
        .mind-ask-empty { font-size:11.5px; color:var(--subtext0); line-height:1.5; background:var(--base); padding:10px 12px; border-radius:6px; }
        .mind-ask-graph { font-size:11px; }
        .mind-ask-graph > summary { cursor:pointer; font-size:10px; font-weight:700; color:var(--subtext0); text-transform:uppercase; letter-spacing:0.6px; list-style:none; display:flex; align-items:center; gap:6px; padding:4px 0; }
        .mind-ask-graph > summary::-webkit-details-marker { display:none; }
        .mind-ask-graph > summary::before { content:'\\25B8'; display:inline-block; transition:transform 0.15s; }
        .mind-ask-graph[open] > summary::before { transform:rotate(90deg); }
        .mind-ask-nodes { display:flex; flex-direction:column; gap:3px; margin-top:6px; max-height:300px; overflow-y:auto; overflow-x:hidden; }
        .mind-ask-nodes a { font-size:11px; color:var(--accent); text-decoration:none; padding:4px 7px; background:var(--mantle); border-radius:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .mind-ask-nodes a:hover { background:var(--surface0); }
        .mind-ask-kind { color:var(--subtext0); }
        .mind-detail-actions { display:flex; gap:8px; padding:12px 14px; border-top:1px solid var(--surface0); background:var(--mantle); flex-shrink:0; }
        .mind-action-btn { font-size:13px; font-weight:600; padding:11px 16px; border-radius:6px; border:1px solid var(--surface1); background:var(--surface0); color:var(--text); cursor:pointer; line-height:1; }
        .mind-action-btn:hover { background:var(--surface1); }
        .mind-action-primary { flex:1; }
        .mind-section-count { background:var(--surface0); color:var(--subtext0); padding:0 6px; border-radius:8px; font-weight:500; font-size:9.5px; }
      </style>`;
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

export { askAbout, build, closeDetail, purgeNode, refreshLock, showCommunityDetail, showNodeDetail, toggleWatch, update };
