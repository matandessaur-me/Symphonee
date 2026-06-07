// mind-ui :: router module. Extracted verbatim from the original single-file
// mind-ui IIFE; wiring is generated. Build: node scripts/build-renderer.js
import { $, state } from './core.js';
import { renderDashboard } from './dashboard.js';
import { closeDetail } from './detailActions.js';
import { teardownNetwork } from './graph.js';
import { renderSkills } from './skills.js';
import { _specsTeardown, renderSpecs } from './specs.js';
import { renderImpact, renderKnowledge, renderMindmap, renderSearch } from './views.js';

  const VIEW_ALIASES = {
    graph: 'mindmap',
    map: 'mindmap',
    smart: 'search',
    query: 'search',
    wakeup: 'dashboard',
    communities: 'mindmap',
    hotspots: 'dashboard',
  };

  function setView(view) {
    const resolved = VIEW_ALIASES[view] || view;
    state.view = resolved;
    document.querySelectorAll('.mind-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === resolved));
    // Close any open node detail when switching Mind sub-tabs - the
    // sidebar context is tied to the previous view's selection.
    try { closeDetail(); } catch (_) {}
    render();
  }

  function render() {
    teardownNetwork();
    _specsTeardown();
    // Mind map + Specs + Skills views are full-bleed (they manage their own layout).
    const main = $('mindMain');
    if (main) {
      const fullBleed = (state.view === 'mindmap' || state.view === 'specs' || state.view === 'skills');
      main.style.padding = fullBleed ? '0' : '14px 18px';
      main.style.overflow = fullBleed ? 'hidden' : '';
      main.style.overflowY = fullBleed ? 'hidden' : 'auto';
      main.style.overflowX = 'hidden';
      main.style.display = fullBleed ? 'flex' : '';
      main.style.flexDirection = fullBleed ? 'column' : '';
    }
    // Skills are procedural recipes, independent of the knowledge graph, so this
    // view renders even before a brain is built.
    if (state.view === 'skills') return renderSkills();
    if (!state.graph) {
      $('mindMain').innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--subtext0);">
          <div style="font-size:14px;margin-bottom:8px;color:var(--text);">No brain yet for this space.</div>
          <div style="font-size:12px;margin-bottom:16px;">Run a build to ingest your notes, learnings, CLI memory, skills, plugins, instructions, and active repo code.</div>
          <button class="tab-bar-btn" onclick="MindUI.build()" style="padding:6px 14px;font-size:12px;">Build the brain</button>
        </div>`;
      return;
    }
    if (state.view === 'dashboard') renderDashboard();
    else if (state.view === 'search') renderSearch();
    else if (state.view === 'impact') renderImpact();
    else if (state.view === 'knowledge') renderKnowledge();
    else if (state.view === 'mindmap') renderMindmap();
    else if (state.view === 'specs') renderSpecs();
  }

  // ── Specs view: search your knowledge anchors, view a focused spec sub-graph,
  // export/import as a KIT. The "spec" and the "KIT export" are the same bounded
  // sub-graph produced by the KIT engine (/api/mind/kit/export). ───────────────

export { VIEW_ALIASES, render, setView };
