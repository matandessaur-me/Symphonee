// mind-ui :: helpers module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $ } from './core.js';
import { cliColor } from './dashboard.js';

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


export { confColor, decodeHtmlEntities, escapeHtml, formatRelativeMs, formatTimestamp, metaRow, neighborRow, nodeLabel, parseWakeupText, renderLocation, renderSource, renderWakeupPreview, renderWakeupStoryLine, shortPath, showGpuInfo };
