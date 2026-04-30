/**
 * Mind visualisation generators.
 *
 *   mermaid(graph, opts)      -> mermaid markdown string
 *   interactive(graph, opts)  -> writes a self-contained HTML file
 *                                (Cytoscape + Dagre via CDN; works in any
 *                                modern browser AND inside Symphonee's
 *                                Electron webview)
 *
 * Output of interactive() is { path } so the caller can open it in a
 * webview or hand it to the user.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40); }

// Selects the "most interesting" sub-graph for a mermaid render: god nodes
// (highest-degree) plus their 1-hop neighbours. Falls back to top-degree
// nodes if the graph has no gods. Cap is enforced at the seed level so the
// final graph never blows past `max` after expansion.
function selectInterestingNodes(graph, max) {
  const degree = new Map();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  // Start from declared gods if present, else top-degree nodes.
  const godIds = (graph.gods || []).map(g => g.id || g).filter(Boolean);
  let seeds = godIds.length
    ? godIds.slice(0, Math.max(8, Math.floor(max / 6)))
    : Array.from(degree.entries()).sort((a, b) => b[1] - a[1]).slice(0, Math.max(8, Math.floor(max / 6))).map(e => e[0]);

  const adj = new Map();
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push(e.target);
    adj.get(e.target).push(e.source);
  }
  const picked = new Set(seeds);
  // 1-hop expansion, ranked by neighbour degree, until cap.
  for (const seed of seeds) {
    if (picked.size >= max) break;
    const neighbours = (adj.get(seed) || [])
      .filter(id => !picked.has(id))
      .sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0))
      .slice(0, 6);
    for (const n of neighbours) {
      picked.add(n);
      if (picked.size >= max) break;
    }
  }
  return picked;
}

function escapeMermaidLabel(s) {
  return String(s == null ? '' : s)
    .replace(/[<>]/g, '')
    .replace(/"/g, "'")
    .replace(/\|/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 38);
}

function mermaidGraph(graph, { focus = null, max = 60, direction = 'LR' } = {}) {
  if (!graph || !graph.nodes) return 'flowchart LR\n  empty["graph empty"]';
  let nodes = graph.nodes;
  let edges = graph.edges;

  if (focus) {
    // BFS 2-hop from a focus node.
    const seen = new Set([focus]);
    let frontier = [focus];
    for (let d = 0; d < 2; d++) {
      const next = [];
      for (const id of frontier) {
        for (const e of edges) {
          if (e.source === id && !seen.has(e.target)) { seen.add(e.target); next.push(e.target); }
          if (e.target === id && !seen.has(e.source)) { seen.add(e.source); next.push(e.source); }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    nodes = nodes.filter(n => seen.has(n.id));
    edges = edges.filter(e => seen.has(e.source) && seen.has(e.target));
  } else {
    // No focus: pick the "interesting" sub-graph instead of slicing the first N.
    const picked = selectInterestingNodes({ nodes, edges, gods: graph.gods }, max);
    nodes = nodes.filter(n => picked.has(n.id));
    edges = edges.filter(e => picked.has(e.source) && picked.has(e.target));
  }

  if (nodes.length > max) nodes = nodes.slice(0, max);
  const allowed = new Set(nodes.map(n => n.id));
  edges = edges.filter(e => allowed.has(e.source) && allowed.has(e.target));

  // Group nodes by community so mermaid lays each community in its own
  // subgraph block - dagre then arranges communities side-by-side instead
  // of dumping every node onto a single rank.
  const groups = new Map(); // communityId -> { label, nodes: [] }
  const ungrouped = [];
  for (const n of nodes) {
    const cid = n.communityId != null ? String(n.communityId) : null;
    if (cid !== null) {
      if (!groups.has(cid)) {
        const cmeta = (graph.communities && graph.communities[cid]) || {};
        groups.set(cid, { label: cmeta.label || `Community ${cid}`, nodes: [] });
      }
      groups.get(cid).nodes.push(n);
    } else {
      ungrouped.push(n);
    }
  }

  const lines = [];
  // Init directive sets layout direction + spacing so the diagram looks like
  // a graph instead of a wide ribbon. flowchart syntax (modern mermaid)
  // honours these; the legacy `graph` keyword does not respect curve/spacing.
  lines.push('%%{init: {"flowchart": {"curve": "basis", "nodeSpacing": 38, "rankSpacing": 56, "diagramPadding": 16, "useMaxWidth": false}}}%%');
  lines.push(`flowchart ${direction}`);

  // Render each community as a subgraph. The `direction` inside subgraphs
  // can differ from the outer one; using TB inside makes each community a
  // tight cluster, while the outer LR keeps clusters side-by-side.
  let gIdx = 0;
  for (const [cid, group] of groups) {
    const safeCid = `cl_${safeId(cid)}_${gIdx++}`;
    lines.push(`  subgraph ${safeCid} ["${escapeMermaidLabel(group.label)}"]`);
    lines.push('    direction TB');
    for (const n of group.nodes) {
      lines.push(`    ${safeId(n.id)}["${escapeMermaidLabel(n.label || n.id)}"]`);
    }
    lines.push('  end');
  }
  for (const n of ungrouped) {
    lines.push(`  ${safeId(n.id)}["${escapeMermaidLabel(n.label || n.id)}"]`);
  }
  for (const e of edges) {
    const arrow = e.confidence === 'EXTRACTED' ? '-->' : e.confidence === 'INFERRED' ? '-.->' : '-.-';
    const rel = e.relation ? `|${escapeMermaidLabel(e.relation)}|` : '';
    lines.push(`  ${safeId(e.source)} ${arrow}${rel} ${safeId(e.target)}`);
  }
  return lines.join('\n');
}

function interactiveHtml(graph, { focus = null, layout = 'cose', title = 'Mind graph' } = {}) {
  const safeNodes = (graph.nodes || []).map(n => ({
    data: {
      id: n.id,
      label: n.label || n.id,
      kind: n.kind || 'node',
      file: n.sourceLocation && n.sourceLocation.file || null,
      line: n.sourceLocation && n.sourceLocation.line || null,
    },
  }));
  const safeEdges = (graph.edges || []).map((e, i) => ({
    data: {
      id: `e${i}`,
      source: e.source,
      target: e.target,
      relation: e.relation || '',
      confidence: e.confidence || '',
    },
  }));
  const elements = JSON.stringify({ nodes: safeNodes, edges: safeEdges });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin:0; padding:0; height:100%; background:#1e1e2e; color:#cdd6f4; font-family:-apple-system,BlinkMacSystemFont,sans-serif; }
  #toolbar { position:absolute; top:0; left:0; right:0; padding:8px 12px; background:#181825; border-bottom:1px solid #313244; display:flex; gap:8px; align-items:center; z-index:5; flex-wrap:wrap; }
  #toolbar input, #toolbar select, #toolbar button { background:#313244; color:#cdd6f4; border:1px solid #45475a; border-radius:3px; padding:4px 8px; font-size:11px; }
  #toolbar button { cursor:pointer; }
  #toolbar button:hover { background:#45475a; }
  #cy { position:absolute; top:42px; left:0; right:340px; bottom:0; }
  #side { position:absolute; top:42px; right:0; bottom:0; width:340px; background:#181825; border-left:1px solid #313244; padding:12px; overflow:auto; font-size:12px; }
  .badge { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; margin-right:4px; }
  .badge.code { background:#94e2d5; color:#181825; }
  .badge.doc { background:#fab387; color:#181825; }
  .badge.note { background:#cba6f7; color:#181825; }
  .badge.artifact { background:#f9e2af; color:#181825; }
  .badge.tag { background:#74c7ec; color:#181825; }
  .badge.symbol { background:#a6e3a1; color:#181825; }
  .badge.conversation { background:#f38ba8; color:#181825; }
  h3 { margin:0 0 8px 0; font-size:13px; color:#f5c2e7; }
  .neighbor { padding:4px 6px; border-bottom:1px solid #313244; cursor:pointer; }
  .neighbor:hover { background:#313244; }
</style>
</head>
<body>
<div id="toolbar">
  <strong style="color:#f5c2e7;">${escapeHtml(title)}</strong>
  <span style="color:#9399b2;">${safeNodes.length} nodes · ${safeEdges.length} edges</span>
  <input id="search" type="text" placeholder="filter nodes..." style="flex:1;min-width:200px;">
  <select id="layout">
    <option value="cose" ${layout === 'cose' ? 'selected' : ''}>Force (cose)</option>
    <option value="grid" ${layout === 'grid' ? 'selected' : ''}>Grid</option>
    <option value="circle" ${layout === 'circle' ? 'selected' : ''}>Circle</option>
    <option value="concentric" ${layout === 'concentric' ? 'selected' : ''}>Concentric</option>
    <option value="breadthfirst" ${layout === 'breadthfirst' ? 'selected' : ''}>Breadth-first</option>
  </select>
  <button id="fit">Fit</button>
  <button id="export">Export PNG</button>
  <button id="impact">Blast radius</button>
</div>
<div id="cy"></div>
<div id="side">
  <h3>Click a node</h3>
  <p style="color:#9399b2;">Hold Shift while clicking to multi-select. Right-click a node to highlight its blast radius.</p>
</div>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.0/dist/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
<script>
(function() {
  const elements = ${elements};
  const focus = ${JSON.stringify(focus)};
  if (window.cytoscapeDagre) cytoscape.use(window.cytoscapeDagre);
  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements: [...elements.nodes, ...elements.edges],
    style: [
      { selector: 'node', style: {
        'label': 'data(label)',
        'background-color': '#89b4fa',
        'color': '#cdd6f4',
        'font-size': 9,
        'text-valign': 'center',
        'text-outline-width': 2,
        'text-outline-color': '#1e1e2e',
        'width': 18, 'height': 18,
      }},
      { selector: 'node[kind = "code"]', style: { 'background-color': '#94e2d5' } },
      { selector: 'node[kind = "doc"]', style: { 'background-color': '#fab387' } },
      { selector: 'node[kind = "note"]', style: { 'background-color': '#cba6f7' } },
      { selector: 'node[kind = "artifact"]', style: { 'background-color': '#f9e2af' } },
      { selector: 'node[kind = "tag"]', style: { 'background-color': '#74c7ec' } },
      { selector: 'node[kind = "symbol"]', style: { 'background-color': '#a6e3a1' } },
      { selector: 'node[kind = "conversation"]', style: { 'background-color': '#f38ba8' } },
      { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#f5c2e7' } },
      { selector: 'edge', style: {
        'width': 1, 'line-color': '#45475a',
        'target-arrow-color': '#45475a', 'target-arrow-shape': 'triangle',
        'curve-style': 'bezier', 'opacity': 0.6,
      }},
      { selector: 'edge[confidence = "EXTRACTED"]', style: { 'line-style': 'solid', 'opacity': 0.8 } },
      { selector: 'edge[confidence = "INFERRED"]', style: { 'line-style': 'dashed' } },
      { selector: 'edge.impact-hop1', style: { 'line-color': '#f38ba8', 'target-arrow-color': '#f38ba8', 'width': 2, 'opacity': 1 } },
      { selector: 'edge.impact-hop2', style: { 'line-color': '#fab387', 'target-arrow-color': '#fab387', 'width': 2, 'opacity': 1 } },
      { selector: 'edge.impact-hop3', style: { 'line-color': '#f9e2af', 'target-arrow-color': '#f9e2af', 'width': 2, 'opacity': 1 } },
      { selector: 'node.impact-hop1', style: { 'border-width': 3, 'border-color': '#f38ba8' } },
      { selector: 'node.impact-hop2', style: { 'border-width': 3, 'border-color': '#fab387' } },
      { selector: 'node.impact-hop3', style: { 'border-width': 3, 'border-color': '#f9e2af' } },
    ],
    layout: { name: '${layout}', animate: false },
    wheelSensitivity: 0.2,
  });

  function showSide(node) {
    const incoming = node.connectedEdges('[target = "' + node.id() + '"]');
    const outgoing = node.connectedEdges('[source = "' + node.id() + '"]');
    const html = [];
    html.push('<h3>' + escape(node.data('label')) + '</h3>');
    html.push('<div><span class="badge ' + escape(node.data('kind')) + '">' + escape(node.data('kind')) + '</span></div>');
    if (node.data('file')) html.push('<div style="margin:6px 0;color:#9399b2;font-family:monospace;font-size:11px;">' + escape(node.data('file')) + (node.data('line') ? ':' + node.data('line') : '') + '</div>');
    html.push('<div style="color:#9399b2;font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin-top:10px;">Incoming (' + incoming.length + ')</div>');
    incoming.forEach(e => {
      const peer = e.source();
      html.push('<div class="neighbor" data-id="' + peer.id() + '">← ' + escape(peer.data('label')) + ' <span style="color:#9399b2;">' + escape(e.data('relation') || '') + '</span></div>');
    });
    html.push('<div style="color:#9399b2;font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin-top:10px;">Outgoing (' + outgoing.length + ')</div>');
    outgoing.forEach(e => {
      const peer = e.target();
      html.push('<div class="neighbor" data-id="' + peer.id() + '">→ ' + escape(peer.data('label')) + ' <span style="color:#9399b2;">' + escape(e.data('relation') || '') + '</span></div>');
    });
    document.getElementById('side').innerHTML = html.join('');
    document.querySelectorAll('.neighbor').forEach(el => el.addEventListener('click', () => {
      const target = cy.$('#' + cssEscape(el.dataset.id));
      if (target.length) { cy.elements().unselect(); target.select(); cy.center(target); }
    }));
  }

  function showImpact(node) {
    cy.elements().removeClass('impact-hop1 impact-hop2 impact-hop3');
    let frontier = [node];
    for (let hop = 1; hop <= 3; hop++) {
      const next = [];
      for (const n of frontier) {
        n.incomers('edge').addClass('impact-hop' + hop);
        n.incomers('node').forEach(p => { if (!p.hasClass('impact-hop1') && !p.hasClass('impact-hop2') && !p.hasClass('impact-hop3') && p.id() !== node.id()) { p.addClass('impact-hop' + hop); next.push(p); } });
      }
      frontier = next;
      if (!next.length) break;
    }
  }

  cy.on('tap', 'node', (e) => showSide(e.target));
  cy.on('cxttap', 'node', (e) => showImpact(e.target));

  document.getElementById('search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    cy.elements().style('opacity', 1);
    if (!q) return;
    cy.nodes().forEach(n => {
      if (!n.data('label').toLowerCase().includes(q)) n.style('opacity', 0.15);
    });
    cy.edges().forEach(e => {
      if (e.source().style('opacity') < 1 || e.target().style('opacity') < 1) e.style('opacity', 0.05);
    });
  });

  document.getElementById('layout').addEventListener('change', (e) => {
    cy.layout({ name: e.target.value, animate: false }).run();
  });
  document.getElementById('fit').addEventListener('click', () => cy.fit());
  document.getElementById('export').addEventListener('click', () => {
    const png = cy.png({ full: true, scale: 2, bg: '#1e1e2e' });
    const a = document.createElement('a'); a.href = png; a.download = 'mind-graph.png'; a.click();
  });
  document.getElementById('impact').addEventListener('click', () => {
    const sel = cy.$('node:selected')[0];
    if (sel) showImpact(sel);
  });

  if (focus) {
    const target = cy.$('#' + cssEscape(focus));
    if (target.length) { target.select(); cy.center(target); showSide(target); }
  }

  function escape(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function cssEscape(s) { return String(s).replace(/([^a-zA-Z0-9-_])/g, '\\\\$1'); }
})();
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function writeInteractive(graph, opts = {}) {
  const html = interactiveHtml(graph, opts);
  const dir = path.join(os.tmpdir(), 'symphonee-mind-viz');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mind-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return { path: file, bytes: Buffer.byteLength(html) };
}

module.exports = { mermaidGraph, interactiveHtml, writeInteractive };
