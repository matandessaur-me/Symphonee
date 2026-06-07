// mind-ui :: lifecycle module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { state } from './core.js';
import { connectWS, loadGraph, refreshQuality, refreshStatus } from './data.js';
import { refreshLock } from './detailActions.js';
import { teardownNetwork } from './graph.js';
import { render } from './router.js';
import { applySearch, bindSearchInput, updateSearchOnlyBtn } from './search.js';

  function onActivate() {
    state.tabActive = true;
    refreshStatus();
    // If a search was active when the user navigated away, replay it after
    // the graph reloads. onDeactivate() drops state.matches to free memory
    // but keeps state.search so the input box (and the user's intent)
    // survives the trip. applySearch() recomputes matches + repaints in
    // one shot for whichever view they came back to.
    loadGraph().then(() => {
      if (state.search) applySearch(state.search);
      else render();
    });
    if (!state.ws) connectWS();
    bindSearchInput();
    updateSearchOnlyBtn();
    refreshLock();
    refreshQuality();
    // Resume physics on re-entry only if the user had it on. Frozen graphs
    // stay frozen - we don't want to undo their preference.
    if (state.network && state.prefs.physicsEnabled !== false && state.graphSettled) {
      try { state.network.setOptions({ physics: { enabled: true } }); } catch (_) {}
    }
  }

  // Called by switchTab() when the user leaves the Mind tab. We fully tear
  // down the network and drop the in-memory graph payload. Memory was the
  // visible problem (946 MB Electron RSS in the screenshot) - the vis
  // DataSets, the raw graph JSON, and the canvas backing store add up to
  // hundreds of MB on a 1k-node graph. Re-fetching on activate is cheap.
  function onDeactivate() {
    state.tabActive = false;
    teardownNetwork();
    state.graph = null;
    state.matches = [];
    // Reset the gate so re-entering the Mind tab shows the entry button
    // again instead of immediately laying out 6k+ nodes.
    state.mindmapLoaded = false;
    // Close the node-detail sidebar so it doesn't reappear stale next
    // time the user opens Mind.
    try { const d = document.getElementById('mindDetail'); if (d) { d.style.display = 'none'; } state.selectedNode = null; } catch (_) {}
  }

  // Pause + tear down when the OS window is hidden. Even with physics off
  // vis-network keeps a rAF loop alive for hover/redraw and Electron does
  // not throttle backgrounded windows the way Chrome throttles tabs.
  if (typeof document !== 'undefined' && !state.visibilityBound) {
    state.visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      const hidden = document.visibilityState === 'hidden';
      if (hidden) {
        if (state.network) {
          try { state.network.setOptions({ autoResize: false, physics: { enabled: false } }); } catch (_) {}
        }
      } else if (state.tabActive && state.network) {
        try {
          state.network.setOptions({
            autoResize: true,
            physics: { enabled: state.prefs.physicsEnabled !== false && state.graphSettled },
          });
        } catch (_) {}
      }
    });
  }

  // ── Search: one input, every view honours state.search ─────────────────────
  // The toolbar input is persistent (lives in the Mind tab, not in any view's
  // body), so we bind once and keep `state.search` as the source of truth.
  // Each renderer reads it; for graph/map we also paint matches on the
  // existing vis-network instance instead of rebuilding.

export { onActivate, onDeactivate };
