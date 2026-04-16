/**
 * Symphonee.contributions - client helper for the plugin-first shell.
 *
 * Phase 4/6 foundation (additive, non-breaking):
 * - Fetches /api/plugins/contributions on load and on plugin list changes.
 * - Exposes window.Symphonee.contributions with helpers so the existing
 *   Backlog, PR, Teams, Activity, GitLog, Settings modules can switch from
 *   hardcoded /api/workitems and /api/github/* calls to provider-driven
 *   calls one at a time.
 *
 * Nothing in the current dashboard consumes this yet. It is safe to ship.
 */
(function () {
  'use strict';

  const state = {
    loaded: false,
    data: null,          // raw /api/plugins/contributions payload
    listeners: new Set(),
  };

  // A route is considered ABSOLUTE when it targets a core/shell endpoint --
  // detected by the "/api/" prefix. Any other leading-slash path (e.g.
  // "/pulls") is RELATIVE to the plugin's own prefix and resolves to
  // "/api/plugins/<id>/pulls". Relative paths without a leading slash work
  // the same way ("pulls" -> "/api/plugins/<id>/pulls").
  function resolveRoute(item, routeField) {
    const route = item && item[routeField];
    if (!route) return null;
    if (route.startsWith('/api/')) return route;             // absolute (core or another plugin)
    const pid = item._origin && item._origin.pluginId;
    if (!pid) return null;
    return '/api/plugins/' + pid + (route.startsWith('/') ? route : '/' + route);
  }

  function notify() {
    for (const fn of state.listeners) {
      try { fn(state.data); } catch (e) { console.warn('contributions listener failed', e); }
    }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/plugins/contributions', { cache: 'no-store' });
      if (!r.ok) throw new Error('status ' + r.status);
      state.data = await r.json();
      state.loaded = true;
      notify();
      return state.data;
    } catch (e) {
      console.warn('Symphonee.contributions: refresh failed', e);
      // Keep previous state on failure; surface null-safe shape so callers can short-circuit.
      if (!state.data) {
        state.data = {
          centerTabs: [], rightTabs: [], leftQuickActions: [], aiActions: [],
          repoSources: [], commitLinkers: [], workItemProviders: [], prProviders: [],
          settingsPanels: [],
        };
      }
      return state.data;
    }
  }

  const api = {
    // Raw accessors
    get loaded() { return state.loaded; },
    get data() { return state.data; },
    refresh,
    onChange(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); },

    // Shell queries
    hasWorkItemProvider() { return !!(state.data && state.data.workItemProviders && state.data.workItemProviders.length); },
    hasPrProvider() { return !!(state.data && state.data.prProviders && state.data.prProviders.length); },
    activeWorkItemProvider() { return (state.data && state.data.workItemProviders && state.data.workItemProviders[0]) || null; },
    activePrProvider() { return (state.data && state.data.prProviders && state.data.prProviders[0]) || null; },

    // Route resolver - accepts a provider object and a route field name, returns an absolute path or null.
    // Usage: Symphonee.contributions.resolve(provider, 'listRoute')
    resolve: resolveRoute,

    // Provider-driven fetch helper for Phase 4b.
    // Picks the active workItem/pr provider, resolves the route field, substitutes :id path
    // params, appends query string, and calls fetch. Returns null when no provider is available
    // so existing call sites can fall back to their hardcoded URL:
    //   const r = await Symphonee.contributions.providerFetch('workItem','listRoute',{query}) ||
    //             await fetch('/api/workitems?'+query);
    async providerFetch(kind, routeField, opts) {
      const p = kind === 'workItem' ? api.activeWorkItemProvider()
              : kind === 'pr'       ? api.activePrProvider()
              : null;
      if (!p) return null;
      let url = resolveRoute(p, routeField);
      if (!url) return null;
      opts = opts || {};
      if (opts.params) {
        for (const [k, v] of Object.entries(opts.params)) url = url.replace(':' + k, encodeURIComponent(v));
      }
      if (opts.query) {
        const qs = typeof opts.query === 'string' ? opts.query : new URLSearchParams(opts.query).toString();
        if (qs) url += (url.includes('?') ? '&' : '?') + qs;
      }
      return fetch(url, opts.init || undefined);
    },

    // Resolve a commit-message / branch-name reference to a URL via registered commitLinkers.
    // Returns { pluginId, url } for the first matching pattern, or null.
    resolveCommitRef(text, tokens) {
      if (!state.data || !Array.isArray(state.data.commitLinkers)) return null;
      tokens = tokens || {};
      for (const linker of state.data.commitLinkers) {
        try {
          const re = new RegExp(linker.pattern);
          const m = re.exec(text);
          if (!m) continue;
          let url = linker.urlTemplate || '';
          url = url.replace(/\{(\d+)\}/g, (_, idx) => m[Number(idx)] || '');
          url = url.replace(/\{(\w+)\}/g, (_, key) => tokens[key] != null ? String(tokens[key]) : '');
          return { pluginId: linker._origin && linker._origin.pluginId, url };
        } catch (_) { /* bad regex in manifest; skip */ }
      }
      return null;
    },

    // Phase 4b helper: call this to gate tabs on provider presence. Dormant until Phase 7
    // flips the default shell behavior; safe to invoke anytime since it only updates
    // display:none on elements that already exist in index.html.
    applyTabVisibility(opts) {
      opts = opts || {};
      const honorLegacyConfig = opts.honorLegacyConfig !== false;
      const setVis = (id, show) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!show) { el.style.display = 'none'; return; }
        // Only unhide if legacy path didn't already hide for its own reason (e.g. incognito).
        if (honorLegacyConfig && el.dataset.pluginFirstHidden === 'incognito') return;
        el.style.display = '';
      };
      setVis('backlogTabBtn', api.hasWorkItemProvider());
      setVis('prsTabBtn', api.hasPrProvider());
    },

    // Phase 6b helper: paint empty-state CTA into a panel when its provider is missing.
    // Dormant (never called by core today); the future shell activates it.
    renderEmptyState(panelId, kind) {
      const panel = document.getElementById(panelId);
      if (!panel) return;
      const suggestions = api.shellEmptyStates().suggestedInstalls.filter(s =>
        (kind === 'workItem' && s.id === 'azure-devops') ||
        (kind === 'pr' && s.id === 'github') ||
        (!kind)
      );
      if (!suggestions.length) return;
      const s = suggestions[0];
      const wrap = document.createElement('div');
      wrap.className = 'plugin-first-empty';
      wrap.style.cssText = 'padding:40px;text-align:center;color:var(--subtext0);';
      wrap.innerHTML =
        '<h3 style="margin:0 0 8px;color:var(--text);">No ' + (kind === 'pr' ? 'pull request' : 'work item') + ' provider installed</h3>' +
        '<p style="margin:0 0 16px;">Install the <strong>' + s.label + '</strong> plugin to ' + s.reason + '.</p>' +
        '<button class="btn btn-primary" onclick="document.getElementById(\'settingsBtn\')?.click()">Open Settings -> Plugins</button>';
      panel.innerHTML = '';
      panel.appendChild(wrap);
    },

    // Phase 6 helper: shell uses this to decide whether to render empty-state CTAs.
    shellEmptyStates() {
      const d = state.data || {};
      return {
        centerHasTabs: (d.centerTabs || []).length > 0,
        rightHasTabs: (d.rightTabs || []).length > 0,
        hasAnyProvider: (d.workItemProviders || []).length + (d.prProviders || []).length > 0,
        suggestedInstalls: [
          ...(!api.hasWorkItemProvider() ? [{ id: 'azure-devops', label: 'Azure DevOps', reason: 'adds the Backlog tab, iterations, teams, and standup/retro AI actions' }] : []),
          ...(!api.hasPrProvider() ? [{ id: 'github', label: 'GitHub', reason: 'adds the Pull Requests tab, git log, and Clone from GitHub' }] : []),
        ],
      };
    },
  };

  window.Symphonee = window.Symphonee || {};
  window.Symphonee.contributions = api;

  // Kick off an initial load; don't block anything if it fails.
  refresh();

  // Re-fetch when the host broadcasts that plugins changed (plugin-loader broadcasts via WS).
  window.addEventListener('symphonee:pluginsChanged', refresh);
})();
