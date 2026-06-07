// mind-ui :: views module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, API, state } from './core.js';
import { setStatus } from './data.js';
import { showNodeDetail } from './detailActions.js';
import { renderGraph } from './graph.js';
import { escapeHtml, renderWakeupPreview } from './helpers.js';

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
    // Lowercase the query so 'Bathfitter' and 'bathfitter' produce
    // identical results. The BM25 backend already lowercases internally,
    // but the dense embedding endpoint passes the query verbatim to the
    // embedding model — and embedding models DO produce different
    // vectors for different casings. Normalizing here keeps both ranker
    // legs operating on the same input so RRF fusion is deterministic.
    const q = ($('mindSmartQ') && $('mindSmartQ').value || '').trim().toLowerCase();
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
    // Same case-normalization as runSmart — keep dense + BM25 on the
    // same input so capital vs lowercase produce identical results.
    const question = ($('mindQueryQ') && $('mindQueryQ').value || '').trim().toLowerCase();
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

export { _impactFiles, _impactSelectedPath, _knowledgeSuggestionsByRepo, artifactsCreate, basenameOf, copyMermaidSource, copyToClipboard, embedAll, refreshSmartHealth, refreshWakeupOutput, renderImpact, renderImpactCircular, renderImpactList, renderKnowledge, renderKnowledgeRepoCard, renderMindmap, renderQuery, renderQueryResult, renderSearch, renderSmart, renderWakeup, runImpactFileBlast, runQueryFromUi, runSmart, selectImpactFile };
