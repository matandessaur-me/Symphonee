// ── Drag-to-reorder pinned tabs ─────────────────────────────────────────
// Tabs use CSS `order` (assigned by CORE_PINNED_CENTER and plugin contributions),
// so drag-reorder must persist an order override per tab rather than mutating
// DOM order, or applyPluginPinnedTabs will re-impose defaults on every repaint.
const TAB_ORDER_KEY = 'symphonee-tab-order-v2';
// One-shot migration: Apps used to live to the left of Browser for some
// users via drag-reorder. Its canonical home is right after Browser
// (CORE_PINNED_CENTER.apps = 3). Dropping only `apps` from the overrides
// leaves Terminal/Orchestrator/Browser pinned to their high saved values
// (10001+) while Apps falls back to 3, which puts Apps FIRST. So clear all
// core-tab overrides together; plugin-tab reorders are preserved.
(function _migrateAppsTabOrder() {
  const MARK = 'symphonee-tab-order-migration-apps-after-browser-v2';
  const CORE_KEYS = ['terminal', 'orchestrator', 'browser', 'apps', 'files', 'diffview', 'notes'];
  try {
    if (localStorage.getItem(MARK)) return;
    const raw = localStorage.getItem(TAB_ORDER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        let changed = false;
        for (const k of CORE_KEYS) {
          if (k in parsed) { delete parsed[k]; changed = true; }
        }
        if (changed) localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(parsed));
      }
    }
    localStorage.setItem(MARK, '1');
  } catch (_) {}
})();
function getSavedTabOrderOverrides() {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) { return {}; }
}
function _restoreTabOrder() {
  const scroll = document.getElementById('tabBarScroll');
  if (!scroll) return;
  const saved = getSavedTabOrderOverrides();
  const keys = Object.keys(saved);
  if (!keys.length) return;
  scroll.querySelectorAll('.tab-btn').forEach(el => {
    const key = el.dataset && el.dataset.tab;
    if (key && Object.prototype.hasOwnProperty.call(saved, key)) {
      el.style.order = String(saved[key]);
    }
  });
}
// Place a newly-revealed closable tab at the far right of the bar. Tabs are
// ordered by CSS `order` (see _saveTabOrder/_restoreTabOrder), so appendChild
// alone is not enough - a tab with no inline `order` falls back to 0 and jumps
// LEFT of every saved tab (which live at 10000+). Assign max+1 and persist.
function _placeTabAtEnd(btn) {
  const scroll = document.getElementById('tabBarScroll');
  if (!scroll || !btn) return;
  if (btn.parentNode !== scroll) scroll.appendChild(btn);
  let maxOrder = 9999;
  scroll.querySelectorAll('.tab-btn').forEach(el => {
    if (el === btn) return;
    const o = parseFloat(el.style.order);
    if (!isNaN(o) && o > maxOrder) maxOrder = o;
  });
  btn.style.order = String(maxOrder + 1);
  try { _saveTabOrder(); } catch (_) {}
}

function _saveTabOrder() {
  const scroll = document.getElementById('tabBarScroll');
  if (!scroll) return;
  // Compute a visual order array (by current `order` then DOM position), then
  // re-assign fresh order values so the overrides beat CORE_PINNED_CENTER and
  // plugin defaults (which top out in the low thousands).
  const BASE = 10000;
  const tabs = [...scroll.querySelectorAll('.tab-btn')]
    .filter(el => el.dataset && el.dataset.tab);
  tabs.sort((a, b) => {
    const ao = parseFloat(a.style.order) || 0;
    const bo = parseFloat(b.style.order) || 0;
    if (ao !== bo) return ao - bo;
    const parent = a.parentNode;
    if (!parent) return 0;
    return Array.prototype.indexOf.call(parent.children, a) -
           Array.prototype.indexOf.call(parent.children, b);
  });
  const saved = {};
  tabs.forEach((el, idx) => {
    const pos = BASE + idx;
    el.style.order = String(pos);
    saved[el.dataset.tab] = pos;
  });
  try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(saved)); } catch (_) {}
}
function _clearTabDropHints() {
  document.querySelectorAll('.tab-btn.drop-before, .tab-btn.drop-after')
    .forEach(el => el.classList.remove('drop-before', 'drop-after'));
}
function _initTabDrag() {
  const scroll = document.getElementById('tabBarScroll');
  if (!scroll) return;
  if (!scroll._dragContainerWired) {
    scroll._dragContainerWired = true;
    // Scroll container as the drop zone so drops between tabs always land.
    scroll.addEventListener('dragover', (e) => {
      if (!scroll.querySelector('.tab-btn.dragging')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    scroll.addEventListener('drop', (e) => {
      const dragging = scroll.querySelector('.tab-btn.dragging');
      if (!dragging) return;
      e.preventDefault();
      _clearTabDropHints();
      _saveTabOrder();
    });
  }
  scroll.querySelectorAll('.tab-btn').forEach(el => {
    if (el._dragWired) return;
    el._dragWired = true;
    el.setAttribute('draggable', 'true');
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/tab-id', el.dataset.tab || '');
      // Firefox requires some dataTransfer payload to actually start a drag.
      try { e.dataTransfer.setData('text/plain', el.dataset.tab || ''); } catch (_) {}
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      _clearTabDropHints();
      _saveTabOrder();
    });
    el.addEventListener('dragover', (e) => {
      const dragging = scroll.querySelector('.tab-btn.dragging');
      if (!dragging || dragging === el) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      _clearTabDropHints();
      el.classList.add(before ? 'drop-before' : 'drop-after');
      // Live-preview the new position by rewriting CSS `order` on every tab so
      // the flex layout immediately reflects where `dragging` would land. DOM
      // insertBefore alone can't override the `order` values we set earlier.
      const tabs = [...scroll.querySelectorAll('.tab-btn')]
        .filter(x => x.dataset && x.dataset.tab && x !== dragging);
      tabs.sort((a, b) => {
        const ao = parseFloat(a.style.order) || 0;
        const bo = parseFloat(b.style.order) || 0;
        if (ao !== bo) return ao - bo;
        return Array.prototype.indexOf.call(a.parentNode.children, a) -
               Array.prototype.indexOf.call(b.parentNode.children, b);
      });
      const insertIdx = tabs.indexOf(el) + (before ? 0 : 1);
      tabs.splice(insertIdx, 0, dragging);
      const BASE = 10000;
      tabs.forEach((t, i) => { t.style.order = String(BASE + i); });
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drop-before', 'drop-after');
    });
  });
}
// Run once after DOM is ready, and re-run whenever tabs are dynamically added.
document.addEventListener('DOMContentLoaded', () => {
  _restoreTabOrder();
  _initTabDrag();
});
// Observe for new tab-btns (plugin tabs) and wire them up.
(function observeTabs() {
  const scroll = document.getElementById('tabBarScroll');
  if (!scroll) { return setTimeout(observeTabs, 200); }
  new MutationObserver(() => _initTabDrag()).observe(scroll, { childList: true });
})();

