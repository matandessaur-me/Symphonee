// mind-ui :: index module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, API, state } from './core.js';
import { refreshQuality } from './data.js';
import { askAbout, build, closeDetail, purgeNode, refreshLock, toggleWatch, update } from './detailActions.js';
import { fitGraph, loadMindmap, setGraphMode } from './graph.js';
import { showGpuInfo } from './helpers.js';
import { onActivate, onDeactivate } from './lifecycle.js';
import { setView } from './router.js';
import { clearSearch, runSearch, toggleSearchOnly } from './search.js';
import { artifactsCreate, embedAll, refreshWakeupOutput, renderWakeup, runQueryFromUi, runSmart } from './views.js';

/**
 * Mind tab UI.
 *
 * Three views over the same graph:
 *   - communities: card grid, each card is one community with cohesion + top gods
 *   - hotspots:    god nodes ranked + surprises ranked (the "what should I look at?" view)
 *   - graph:       interactive force-directed graph powered by vis-network
 *
 * Side panel on the right shows full node detail when a node is clicked.
 *
 * vis-network is the same library graphify uses for its graph.html output -
 * battle-tested physics, smooth zoom/pan, edge labels on hover, community
 * highlighting, focus animation. Loaded as a global `vis` from the static
 * bundle at /vis-network.min.js.
 */

  window.MindUI = { onActivate, onDeactivate, setView, build, update, toggleWatch, askAbout, purgeNode, closeDetail, fitGraph, setGraphMode, loadMindmap, clearSearch, runSearch, toggleSearchOnly, showGpuInfo,
    deselectNode: () => { if (state.fgClearHighlight) state.fgClearHighlight(); },
    showConnected: () => { if (state.fgShowConnected) state.fgShowConnected(); },
    refreshLock, refreshQuality,
    _wakeupRefresh: refreshWakeupOutput,
    _queryRun: runQueryFromUi,
    _smartRun: runSmart,
    _embedAll: embedAll,
    _artifactsCreate: artifactsCreate,
    _wakeupOpen: () => { state.view = 'dashboard'; renderWakeup(); },
    _healthCheck: async () => {
      const el = document.getElementById('mindDiagOut');
      if (!el) return;
      el.textContent = 'checking...';
      try {
        const h = await API('/api/mind/health');
        const e = h.embeddings || {}; const v = h.vectors || {};
        const embedText = e.ok ? `embed:ok(${e.provider || '?'},${e.dimensions || '?'}d)` : 'embed:not configured';
        el.textContent = `${embedText} · vectors:${v.count || 0}/${v.dim || 0}d`;
      } catch (err) { el.textContent = 'error: ' + (err.message || err); }
    },
  };
