// ── Point-of-need install for the local reasoning model ─────────────────────
// Any feature that needs the local reasoning model (gemma4:26b) calls
// `await symphEnsureLocalModel({ reason })` instead of failing silently or
// hiding the option. It resolves true when the model is ready, false if the
// user declines. The modal handles every state -- Ollama missing (link out),
// Ollama not running (re-check), or the model not pulled (one-click install
// with live progress). This is how we tell the user they need the 16 GB model:
// exactly when they reach for something that uses it, never as a boot surprise.

async function symphEnsureLocalModel(opts = {}) {
  const reason = opts.reason || 'This feature uses the local reasoning model.';
  let status = {};
  try { status = await fetch('/api/symphonee/setup/check').then((r) => r.json()); } catch (_) {}
  if (status && status.reasoningModelInstalled) return true;
  return new Promise((resolve) => _symphModelModal(status || {}, reason, resolve));
}

function _symphModelModal(status, reason, resolve) {
  const model = status.reasoningModel || 'gemma4:26b';
  const oldEl = document.getElementById('symphModelModal');
  if (oldEl) oldEl.remove();
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  let body, actions;
  if (!status.ollamaInstalled) {
    body = `${esc(reason)}<br><br>Local AI runs on <b>Ollama</b>, which isn't installed yet. Install it (free, a few minutes), then come back.`;
    actions = '<a href="https://ollama.com/download" target="_blank" rel="noopener" class="symph-mm-btn symph-mm-primary">Get Ollama</a>'
      + '<button class="symph-mm-btn" data-mm="recheck">I installed it</button>'
      + '<button class="symph-mm-btn symph-mm-ghost" data-mm="cancel">Cancel</button>';
  } else if (!status.ollamaRunning) {
    body = `${esc(reason)}<br><br>Ollama is installed but not running. Start it, then re-check.`;
    actions = '<button class="symph-mm-btn symph-mm-primary" data-mm="recheck">Re-check</button>'
      + '<button class="symph-mm-btn symph-mm-ghost" data-mm="cancel">Cancel</button>';
  } else {
    body = `${esc(reason)}<br><br>It uses the local reasoning model <b>${esc(model)}</b> (~16 GB, one-time download). Memory and lighter work run without it; this unlocks deeper local reasoning and the local automation provider.`;
    actions = '<button class="symph-mm-btn symph-mm-primary" data-mm="install">Install (~16 GB)</button>'
      + '<button class="symph-mm-btn symph-mm-ghost" data-mm="cancel">Not now</button>';
  }

  const ov = document.createElement('div');
  ov.id = 'symphModelModal';
  ov.className = 'symph-mm-overlay';
  ov.innerHTML = '<div class="symph-mm-card">'
    + '<div class="symph-mm-head"><i data-lucide="cpu"></i> Local reasoning model</div>'
    + `<div class="symph-mm-body">${body}</div>`
    + '<div class="symph-mm-prog" id="symphMmProg" style="display:none;"><div class="symph-mm-bar"><div class="symph-mm-bar-fill" id="symphMmBar"></div></div><div class="symph-mm-txt" id="symphMmTxt">Starting download...</div></div>'
    + `<div class="symph-mm-actions">${actions}</div>`
    + '</div>';
  document.body.appendChild(ov);
  if (typeof lucide !== 'undefined') { try { lucide.createIcons({ el: ov }); } catch (_) {} }

  const onPull = (e) => {
    const p = e.detail || {};
    if (p.kind !== 'ollama-pull' || (p.model && p.model !== model)) return;
    const prog = document.getElementById('symphMmProg'); if (prog) prog.style.display = '';
    const txt = document.getElementById('symphMmTxt');
    const bar = document.getElementById('symphMmBar');
    if (p.status === 'success') { if (txt) txt.textContent = 'Done.'; if (bar) bar.style.width = '100%'; setTimeout(() => done(true), 700); return; }
    if (p.status === 'error') { if (txt) txt.textContent = 'Download failed -- check the console and try again.'; return; }
    const gb = (n) => Math.round((n || 0) / 1e9 * 10) / 10;
    if (txt) txt.textContent = (p.status || 'downloading') + (p.total ? ` -- ${gb(p.completed)} / ${gb(p.total)} GB` : '');
    if (bar && p.total) bar.style.width = Math.min(100, Math.round((p.completed || 0) / p.total * 100)) + '%';
  };

  function done(val) {
    window.removeEventListener('symphonee-mind-update', onPull);
    const o = document.getElementById('symphModelModal'); if (o) o.remove();
    resolve(!!val);
  }

  ov.addEventListener('click', async (e) => {
    if (e.target === ov) { done(false); return; } // click outside the card
    const act = e.target.closest('[data-mm]');
    if (!act) return; // links / body clicks: let default happen, keep modal open
    const which = act.getAttribute('data-mm');
    if (which === 'cancel') { done(false); return; }
    if (which === 'recheck') {
      let s = {}; try { s = await fetch('/api/symphonee/setup/check').then((r) => r.json()); } catch (_) {}
      if (s && s.reasoningModelInstalled) { done(true); return; }
      window.removeEventListener('symphonee-mind-update', onPull);
      const o = document.getElementById('symphModelModal'); if (o) o.remove();
      _symphModelModal(s || {}, reason, resolve);
      return;
    }
    if (which === 'install') {
      window.addEventListener('symphonee-mind-update', onPull);
      act.disabled = true; act.textContent = 'Downloading...';
      const prog = document.getElementById('symphMmProg'); if (prog) prog.style.display = '';
      try { await fetch('/api/symphonee/setup/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }); } catch (_) {}
      // completion / progress arrives via onPull (symphonee-mind-update events)
    }
  });
}
