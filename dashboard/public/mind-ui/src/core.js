// mind-ui :: core module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { render } from './router.js';

  const API = (path, opts = {}) => fetch(path, opts).then(r => r.json());
  const $ = (id) => document.getElementById(id);

  // Persisted UI prefs for the graph view. Survives tab switches and reloads
  // so a "Show everything" + paused-physics setup stays put when the user
  // wanders off and comes back.
  const PREFS_KEY = 'mind-ui-prefs:v1';
  // Physics default = off (frozen). Stabilization still runs once to lay
  // out the graph, then physics is disabled so weaker machines aren't stuck
  // animating forever. The user can resume it from the Freeze button.
  // searchOnly: true is now the only mode (the toggle button was removed).
  // When the user enters a search, only matching nodes render. When the
  // search is empty, every node renders. This is what the user expected
  // and removes a footgun (the toggle would partially-cache layout).
  const DEFAULT_PREFS = { graphCap: '200', graphFilter: 'all', physicsEnabled: false, searchOnly: true, graphMode: '3d' };
  function loadPrefs() {
    try {
      const merged = Object.assign({}, DEFAULT_PREFS, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
      // searchOnly is now hardcoded on — force it true regardless of
      // what's in localStorage from older sessions where the toggle
      // could be off.
      merged.searchOnly = true;
      return merged;
    } catch (_) { return Object.assign({}, DEFAULT_PREFS); }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch (_) {}
  }

  let state = {
    view: 'dashboard',
    graph: null,
    selectedNode: null,
    watchEnabled: false,
    graphBuildSeq: 0,      // increments per graph rebuild so stale completions are ignored
    network: null,         // vis.Network instance
    visNodes: null,        // vis.DataSet for nodes
    visEdges: null,        // vis.DataSet for edges
    graphSettled: false,   // true after the current vis-network stabilization pass
    ws: null,
    search: '',            // current search term (lowercased, trimmed)
    matches: [],           // ids of nodes matching state.search, ordered
    matchIndex: 0,         // current cursor for Enter-cycling
    prefs: loadPrefs(),    // persisted graph cap/filter/physics
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────

export { $, API, DEFAULT_PREFS, PREFS_KEY, loadPrefs, savePrefs, state };
