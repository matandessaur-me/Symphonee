// mind-ui :: search module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, savePrefs, state } from './core.js';
import { showNodeDetail } from './detailActions.js';
import { buildNetwork, buildNetworkAsync } from './graph.js';
import { render } from './router.js';

  let searchBound = false;
  function bindSearchInput() {
    if (searchBound) return;
    const input = $('mindSearchInput');
    if (!input) return;
    searchBound = true;
    // Search no longer fires on every keystroke - rebuilding the 3D
    // graph mid-typing was redrawing the network on every character.
    // Now you commit a search via Enter or the Go button. Arrow keys
    // still cycle through hits when a search is already active.
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (state.search && state.matches.length) {
          cycleMatch(ev.shiftKey ? -1 : 1);
        } else {
          applySearch(input.value);
        }
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        clearSearch();
      } else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && state.matches.length) {
        ev.preventDefault();
        cycleMatch(ev.key === 'ArrowRight' ? 1 : -1);
      }
    });
  }
  function runSearch() {
    const input = $('mindSearchInput');
    if (!input) return;
    applySearch(input.value);
  }

  function toggleSearchOnly() {
    state.prefs.searchOnly = !state.prefs.searchOnly;
    savePrefs();
    updateSearchOnlyBtn();
    // Re-render the active view so the new mode lands. Same dispatch as
    // applySearch(): graph/map paint in place, others rebuild.
    if (state.view === 'graph') paintGraphSearch();
    else render();
  }

  function updateSearchOnlyBtn() {
    const btn = $('mindSearchOnlyBtn');
    if (!btn) return;
    const on = !!state.prefs.searchOnly;
    btn.textContent = on ? 'Search only: on' : 'Search only: off';
    btn.style.color = on ? 'var(--accent)' : 'var(--subtext0)';
    btn.style.borderColor = on ? 'var(--accent)' : 'var(--surface1)';
  }

  function clearSearch() {
    const input = $('mindSearchInput');
    if (input) input.value = '';
    applySearch('');
  }

  // Normalize away word separators so "bathfitter", "bath fitter",
  // "bath_fitter", and "Bath-Fitter" all match the same set of nodes.
  // Without this, repos that smush the brand together ("bathfitter") only
  // match nodes that also smush, while repos that split it ("bath_fitter")
  // match a different set - and the user has to guess which spelling is
  // in the graph today.
  function normForSearch(s) {
    return typeof s === 'string' ? s.toLowerCase().replace(/[\s_.\-@]+/g, '') : '';
  }

  function nodeMatchesSearch(n, q) {
    if (!q) return false;
    const qn = normForSearch(q);
    if (typeof n.label === 'string') {
      const lbl = n.label.toLowerCase();
      if (lbl.includes(q)) return true;
      if (qn && normForSearch(n.label).includes(qn)) return true;
    }
    if (typeof n.id === 'string') {
      const idl = n.id.toLowerCase();
      if (idl.includes(q)) return true;
      if (qn && normForSearch(n.id).includes(qn)) return true;
    }
    if (Array.isArray(n.tags)) {
      for (const t of n.tags) {
        if (typeof t !== 'string') continue;
        const tl = t.toLowerCase();
        if (tl.includes(q)) return true;
        if (qn && normForSearch(t).includes(qn)) return true;
      }
    }
    return false;
  }

  function recomputeMatches() {
    const q = state.search;
    if (!q || !state.graph) { state.matches = []; state.matchIndex = 0; return; }
    // Rank: label-prefix > label-substring > id/tags. Then by degree desc so
    // important nodes surface first - the user almost always means those.
    const degree = new Map();
    for (const e of state.graph.edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    const qn = normForSearch(q);
    const scored = [];
    for (const n of state.graph.nodes) {
      if (!nodeMatchesSearch(n, q)) continue;
      const lbl = (n.label || '').toLowerCase();
      const lblN = normForSearch(n.label || '');
      const idN = normForSearch(n.id || '');
      let rank = 4;
      if (lbl.startsWith(q)) rank = 0;
      else if (lbl.includes(q)) rank = 1;
      else if (qn && lblN.startsWith(qn)) rank = 2;
      else if (qn && lblN.includes(qn)) rank = 2;
      else if ((n.id || '').toLowerCase().includes(q)) rank = 3;
      else if (qn && idN.includes(qn)) rank = 3;
      scored.push({ id: n.id, rank, deg: degree.get(n.id) || 0 });
    }
    scored.sort((a, b) => a.rank - b.rank || b.deg - a.deg);
    let matchIds = scored.map(x => x.id);

    // Expand matches one hop along semantic edges so the user SEES
    // related entities ("DYOB is connected to Bath Fitter") without
    // pulling in the full cohort. If they want the cohort they click
    // the related entity to drill in - cheaper for the eye, cheaper for
    // the LLM if the search context is later sent as graph state.
    //
    // Edges traversed: conceptually_related_to (either direction) and
    // mentions where the OTHER end is a kind:entity. Nothing more. An
    // earlier version added Stage 2 (each reached entity's incoming
    // mentions, capped at 50) which made "DYOB" pull every Bath Fitter
    // node and visually drowned the actual answer. Removed.
    if (matchIds.length) {
      const matchSet = new Set(matchIds);
      const nodeById = new Map();
      for (const n of state.graph.nodes) nodeById.set(n.id, n);
      const added = [];
      for (const e of state.graph.edges) {
        const inSrc = matchSet.has(e.source);
        const inTgt = matchSet.has(e.target);
        if (inSrc === inTgt) continue;
        const peer = inSrc ? e.target : e.source;
        if (matchSet.has(peer)) continue;
        const peerNode = nodeById.get(peer);
        if (!peerNode) continue;
        const isEntityHop = peerNode.kind === 'entity';
        const isRelEdge = e.relation === 'conceptually_related_to';
        const isMentionToEntity = e.relation === 'mentions' && isEntityHop;
        if (!isRelEdge && !isMentionToEntity) continue;
        matchSet.add(peer);
        added.push(peer);
      }
      matchIds = matchIds.concat(added);
    }

    state.matches = matchIds;
    state.matchIndex = 0;
  }

  function applySearch(rawQuery) {
    state.search = (rawQuery || '').trim().toLowerCase();
    recomputeMatches();
    updateSearchUi();
    // Re-render the active view. Graph + mindmap views prefer in-place
    // re-paint (paintGraphSearch -> buildNetworkAsync) so we don't blow
    // away the canvas DOM and accidentally resurface the 'Enter Mind Map'
    // gate. Other views can rebuild — they're cheap.
    if (state.view === 'graph' || state.view === 'mindmap') paintGraphSearch();
    else render();
    // If we have a match, surface it in the detail panel automatically.
    if (state.matches.length) showNodeDetail(state.matches[0]);
  }

  function cycleMatch(step) {
    if (!state.matches.length) return;
    state.matchIndex = (state.matchIndex + step + state.matches.length) % state.matches.length;
    const id = state.matches[state.matchIndex];
    updateSearchUi();
    if (state.view === 'graph') paintGraphSearch(id);
    showNodeDetail(id);
  }

  function updateSearchUi() {
    const count = $('mindSearchCount');
    const clear = $('mindSearchClear');
    if (clear) clear.style.display = state.search ? '' : 'none';
    if (!count) return;
    if (!state.search) { count.textContent = ''; return; }
    if (!state.matches.length) { count.textContent = '0'; count.style.color = 'var(--red)'; return; }
    count.style.color = 'var(--subtext0)';
    count.textContent = state.matches.length === 1
      ? '1'
      : `${state.matchIndex + 1}/${state.matches.length}`;
  }

  // Graph view: rebuild the network so match-aware styling lands cleanly,
  // then focus the current cursor. buildNetwork() reads state.search.
  function paintGraphSearch(focusId) {
    if (!state.graph) return;
    buildNetworkAsync({
      focusId: focusId || state.matches[state.matchIndex],
      loaderText: state.prefs.graphCap === 'all' ? 'Refreshing full graph...' : 'Refreshing graph...',
    });
  }


export { applySearch, bindSearchInput, clearSearch, cycleMatch, nodeMatchesSearch, normForSearch, paintGraphSearch, recomputeMatches, runSearch, searchBound, toggleSearchOnly, updateSearchOnlyBtn, updateSearchUi };
