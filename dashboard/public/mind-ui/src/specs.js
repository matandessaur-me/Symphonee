// mind-ui :: specs module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $ } from './core.js';
import { showNodeDetail } from './detailActions.js';
import { KIND_COLOR } from './graph.js';
import { escapeHtml, nodeLabel } from './helpers.js';

  const _spec = { anchors: null, selected: null, kit: null, fg: null, filter: '' };
  function _toast(msg, kind) { try { if (typeof window.toast === 'function') window.toast(msg, kind); } catch (_) {} }
  function _specsTeardown() {
    if (_spec.fg) { try { _spec.fg._destructor && _spec.fg._destructor(); } catch (_) {} _spec.fg = null; }
  }
  async function renderSpecs() {
    const main = $('mindMain');
    if (!main) return;
    main.innerHTML =
      '<div style="display:flex;width:100%;height:100%;min-height:0;">' +
        '<div style="width:300px;flex-shrink:0;border-right:1px solid var(--surface0);display:flex;flex-direction:column;min-height:0;">' +
          '<div style="padding:12px 12px 8px;display:flex;flex-direction:column;gap:8px;">' +
            '<input id="specsSearch" placeholder="Search your knowledge..." autocomplete="off" spellcheck="false" style="background:var(--surface0);border:1px solid var(--surface1);border-radius:8px;color:var(--text);font-size:12px;padding:9px 11px;outline:none;transition:border-color .15s,box-shadow .15s;">' +
            '<div style="display:flex;gap:6px;">' +
              '<button id="specsImportBtn" class="tab-bar-btn" style="flex:1;font-size:11px;">Import KIT</button>' +
              '<input id="specsImportFile" type="file" accept="application/json,.json" style="display:none;">' +
            '</div>' +
          '</div>' +
          '<div id="specsList" style="flex:1;overflow-y:auto;padding:0 8px 12px;"></div>' +
        '</div>' +
        '<div style="flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;">' +
          '<div id="specsHeader" style="padding:12px 16px;border-bottom:1px solid var(--surface0);display:flex;align-items:center;gap:10px;min-height:22px;">' +
            '<span style="font-size:12px;color:var(--subtext0);">Pick a subject to see its knowledge spec, then export it as a KIT to share.</span>' +
          '</div>' +
          '<div id="specsGraph" style="flex:1;min-height:0;position:relative;background:radial-gradient(900px 520px at 50% 28%, color-mix(in srgb, var(--accent) 7%, transparent), transparent);"></div>' +
        '</div>' +
      '</div>';
    const search = $('specsSearch');
    if (search) {
      search.addEventListener('input', () => { _spec.filter = search.value; _renderAnchorList(); });
      search.addEventListener('focus', () => { search.style.borderColor = 'var(--accent)'; search.style.boxShadow = '0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)'; });
      search.addEventListener('blur', () => { search.style.borderColor = 'var(--surface1)'; search.style.boxShadow = ''; });
      setTimeout(() => { try { search.focus(); } catch (_) {} }, 60);
    }
    const importBtn = $('specsImportBtn'), importFile = $('specsImportFile');
    if (importBtn && importFile) { importBtn.onclick = () => importFile.click(); importFile.onchange = () => _specsIngest(importFile); }
    if (!_spec.anchors) {
      $('specsList').innerHTML = '<div style="padding:12px;color:var(--subtext0);font-size:11px;">Loading subjects...</div>';
      try { const r = await fetch('/api/mind/anchors'); const d = await r.json(); _spec.anchors = d.subjects || d.anchors || []; } catch (_) { _spec.anchors = []; }
    }
    _renderAnchorList();
    if (_spec.selected) _specsSelect(_spec.selected, true);
  }
  // Compact "what this subject contains" line, e.g. "142 code . 23 conv . 8 notes".
  function _countsLine(counts) {
    if (!counts) return '';
    const labelFor = { code: 'code', note: 'notes', conversation: 'conv', drawer: 'sessions', concept: 'concepts', doc: 'docs', recipe: 'recipes', artifact: 'artifacts', memory: 'memories', insight: 'insights', tag: 'tags', entity: 'entities' };
    const order = ['code', 'note', 'conversation', 'drawer', 'concept', 'doc', 'recipe', 'artifact', 'memory', 'insight'];
    const parts = [];
    for (const k of order) {
      if (counts[k]) parts.push(counts[k] + ' ' + (labelFor[k] || k));
      if (parts.length >= 4) break;
    }
    return parts.join('  .  ');
  }
  function _renderAnchorList() {
    const host = $('specsList'); if (!host) return;
    const f = (_spec.filter || '').trim().toLowerCase();
    let list = _spec.anchors || [];
    if (f) list = list.filter(a => a.label.toLowerCase().indexOf(f) >= 0 || (a.kind || '').toLowerCase().indexOf(f) >= 0);
    const shown = list.slice(0, 200);
    if (!shown.length) { host.innerHTML = '<div style="padding:12px;color:var(--subtext0);font-size:11px;">' + (f ? 'No matches.' : 'No subjects yet - build the brain first.') + '</div>'; return; }
    host.innerHTML = shown.map(a => {
      const sel = _spec.selected && _spec.selected.id === a.id;
      const color = KIND_COLOR[a.kind] || '#9399b2';
      const breakdown = _countsLine(a.counts);
      return '<div class="specs-item" data-id="' + escapeHtml(a.id) + '" style="display:flex;align-items:flex-start;gap:8px;padding:8px 9px;border-radius:8px;cursor:pointer;margin-bottom:2px;' + (sel ? 'background:color-mix(in srgb, var(--accent) 20%, var(--surface0));' : '') + '">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex-shrink:0;box-shadow:0 0 6px ' + color + '66;margin-top:3px;"></span>' +
        '<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;">' +
          '<span style="display:flex;align-items:center;gap:6px;">' +
            '<span style="flex:1;font-size:12.5px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(a.label) + '</span>' +
            '<span style="font-size:8.5px;color:var(--subtext0);text-transform:uppercase;letter-spacing:.4px;flex-shrink:0;padding:1px 5px;border-radius:6px;background:' + color + '22;">' + escapeHtml(a.kind) + '</span>' +
          '</span>' +
          (breakdown ? '<span style="font-size:10px;color:var(--subtext0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(breakdown) + '</span>' : '') +
        '</span>' +
      '</div>';
    }).join('') + (list.length > shown.length ? '<div style="padding:8px 9px;color:var(--subtext0);font-size:10px;">+' + (list.length - shown.length) + ' more - keep typing to narrow</div>' : '');
    host.querySelectorAll('.specs-item').forEach(el => {
      const id = el.getAttribute('data-id');
      el.addEventListener('click', () => { const a = (_spec.anchors || []).find(x => x.id === id); if (a) _specsSelect(a); });
      el.addEventListener('mouseenter', () => { if (!(_spec.selected && _spec.selected.id === id)) el.style.background = 'var(--surface0)'; });
      el.addEventListener('mouseleave', () => { if (!(_spec.selected && _spec.selected.id === id)) el.style.background = ''; });
    });
  }
  async function _specsSelect(anchor, keepGraph) {
    _spec.selected = anchor;
    _renderAnchorList();
    const header = $('specsHeader'), graphHost = $('specsGraph');
    if (header) header.innerHTML =
      '<span style="font-size:13px;font-weight:600;color:var(--text);">' + escapeHtml(anchor.label) + '</span>' +
      '<span style="font-size:9px;color:var(--subtext0);text-transform:uppercase;letter-spacing:.3px;">' + escapeHtml(anchor.kind) + '</span>' +
      '<span id="specsCounts" style="font-size:11px;color:var(--subtext0);">building...</span>' +
      '<span style="flex:1;"></span>' +
      '<button id="specsExportBtn" class="tab-bar-btn" style="font-size:11px;">Export KIT</button>';
    const exportBtn = $('specsExportBtn'); if (exportBtn) exportBtn.onclick = () => _specsExport();
    if (keepGraph && _spec.kit) { _renderSpecGraph(_spec.kit); const c = $('specsCounts'); if (c) c.textContent = _specKitCounts(_spec.kit); return; }
    if (graphHost) graphHost.innerHTML = '<div style="padding:30px;color:var(--subtext0);font-size:12px;">Building spec...</div>';
    let kit = null;
    try {
      // Use ALL the subject's merged seeds (repo + tag + entity) so the spec is
      // everything connected to the subject, not just one node. A higher node cap
      // lets notes + conversations through, not only code.
      const seedIds = (anchor.seedIds && anchor.seedIds.length) ? anchor.seedIds : [anchor.id];
      const r = await fetch('/api/mind/kit/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seedIds, maxNodes: 500, maxDepth: 3 }) });
      const d = await r.json();
      if (d.ok) kit = d.kit;
    } catch (_) {}
    if (_spec.selected !== anchor) return; // selection changed while loading
    if (!kit) { if (graphHost) graphHost.innerHTML = '<div style="padding:30px;color:var(--subtext0);font-size:12px;">No connected knowledge for this subject.</div>'; return; }
    _spec.kit = kit;
    const counts = $('specsCounts'); if (counts) counts.textContent = _specKitCounts(kit);
    _renderSpecGraph(kit);
  }
  // Header summary for a loaded spec: total + the kinds that matter for sharing.
  function _specKitCounts(kit) {
    const by = {};
    for (const n of (kit.nodes || [])) { if (n) by[n.kind] = (by[n.kind] || 0) + 1; }
    const line = _countsLine(by);
    return kit.stats.nodes + ' nodes . ' + kit.stats.edges + ' edges' + (line ? '  (' + line + ')' : '');
  }
  function _renderSpecGraph(kit) {
    const host = $('specsGraph'); if (!host) return;
    _specsTeardown();
    host.innerHTML = '';
    if (typeof window.ForceGraph !== 'function') { host.innerHTML = '<div style="padding:30px;color:var(--subtext0);">Graph renderer unavailable.</div>'; return; }
    const nodes = kit.nodes.map(n => ({ id: n.id, label: n.label, kind: n.kind, color: KIND_COLOR[n.kind] || '#9399b2' }));
    const idset = new Set(nodes.map(n => n.id));
    const links = (kit.edges || []).filter(e => idset.has(e.source) && idset.has(e.target)).map(e => ({ source: e.source, target: e.target }));
    try {
      const fg = window.ForceGraph()(host)
        .graphData({ nodes, links })
        .backgroundColor('rgba(0,0,0,0)')
        .nodeRelSize(4)
        .nodeColor(n => n.color)
        .nodeLabel(n => escapeHtml(n.label) + '  [' + n.kind + ']')
        .linkColor(() => 'rgba(150,150,180,0.22)')
        .linkWidth(0.6)
        .onNodeClick(n => { try { showNodeDetail(n.id); } catch (_) {} })
        .width(host.clientWidth || 600)
        .height(host.clientHeight || 400);
      _spec.fg = fg;
    } catch (e) { host.innerHTML = '<div style="padding:30px;color:var(--subtext0);">Could not render spec graph.</div>'; }
  }
  function _specsExport() {
    const kit = _spec.kit; if (!kit) return;
    try {
      const blob = new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safe = String((_spec.selected && _spec.selected.label) || 'kit').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40);
      a.href = url; a.download = 'kit-' + safe + '.json'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      _toast('KIT exported (' + kit.stats.nodes + ' nodes)', 'success');
    } catch (_) { _toast('Export failed', 'error'); }
  }
  async function _specsIngest(input) {
    const file = input.files && input.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const kit = JSON.parse(text);
      if (!kit || !Array.isArray(kit.nodes)) { _toast('Not a valid KIT file', 'error'); input.value = ''; return; }
      const r = await fetch('/api/mind/kit/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kit }) });
      const d = await r.json();
      if (d.ok) { _toast('Ingested ' + d.addedNodes + ' new nodes (' + d.skippedNodes + ' already known)', 'success'); _spec.anchors = null; renderSpecs(); }
      else _toast('Ingest failed: ' + (d.reason || ''), 'error');
    } catch (_) { _toast('Ingest failed', 'error'); }
    input.value = '';
  }

  // ── Skills view: the procedural layer of the brain (browse/author skills +
  // review the reflection loop's proposed skills). Lives under Mind because
  // skills are part of the brain; independent of the knowledge graph. Exposed on
  // window so inline handlers resolve, mirroring the other Mind sub-views. ──────

export { _countsLine, _renderAnchorList, _renderSpecGraph, _spec, _specKitCounts, _specsExport, _specsIngest, _specsSelect, _specsTeardown, _toast, renderSpecs };
