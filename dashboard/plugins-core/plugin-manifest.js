// plugin-manifest -- the pure manifest layer of the plugin loader: the catalog
// of known contribution types (v1 + v2), legacy-shape normalization, contribution
// validation (warnings), and activation-condition checking. No fs/IO -- split from
// plugin-loader.js so plugin correctness rules can be unit-tested directly.
// Known contribution types. v1 is what plugins shipped with today.
// v2 adds the surfaces needed to extract Azure DevOps and GitHub into plugins.
const KNOWN_CONTRIBUTIONS_V1 = new Set([
  'settingsHtml', 'centerTabs', 'routes', 'mcp',
]);
const KNOWN_CONTRIBUTIONS_V2 = new Set([
  'leftQuickActions',   // [{id,label,icon,command}] injected into left rail
  'rightTabs',          // [{id,label,icon,html,pinned?,position?}] right-column tabs
  'repoSources',        // declare a repo provider (name, clone handler, list handler)
  'commitLinkers',      // {pattern, resolver} for auto-linking commit refs (e.g. AB#123)
  'workItemProvider',   // implements {list,get,update,create,iterations,teams,activity}
  'prProvider',         // implements {list,get,create,merge}
  'aiActions',          // [{id,label,icon,prompt}] AI quick actions (standup, retro, etc.)
  'nativeSettings',     // {targetId, hideNavSelector?} claim an existing settings DOM block
  'sensitiveKeys',      // string[] -- config keys that must be stripped from exports and preserved across imports
  'imageAuth',          // [{hostnamePattern,authType,authConfigKey}] -- register URL-pattern auth injectors for the core image proxy
  'configKeys',         // string[] -- config keys owned by this plugin and persisted in plugin config.json
]);
const ALL_KNOWN_CONTRIBUTIONS = new Set([
  ...KNOWN_CONTRIBUTIONS_V1, ...KNOWN_CONTRIBUTIONS_V2,
]);

// Normalize the legacy `legacyNativeTabs` / `legacyNativeRightTabs` shape into
// the current `centerTabs` / `rightTabs` + `pinned: true` + `claims` shape.
// The old plugin manifests shipped before the SDK exposed pinned tabs publicly;
// we rewrite them in place so the rest of the loader and the client code see one model.
function normalizeLegacyShapes(manifest) {
  const c = manifest.contributions;
  if (!c) return;
  const migrate = (legacyKey, modernKey) => {
    const list = c[legacyKey];
    if (!Array.isArray(list) || list.length === 0) return;
    if (!Array.isArray(c[modernKey])) c[modernKey] = [];
    list.forEach((t, idx) => {
      if (!t || !t.tabBtnId) return;
      const id = t.id
        || (t.tabBtnId.replace(/TabBtn$/, '').replace(/^intelTab-/, '') || `tab${idx}`);
      // Legacy semantics: openable:false meant "hidden until plugin code reveals
      // it" (Work Item, Activity Timeline). That is now `popup: true`. Anything
      // else stays a `pinned` always-visible tab.
      const isPopup = t.openable === false;
      c[modernKey].push({
        id,
        label: t.label || '',
        icon: t.icon || null,
        pinned: !isPopup,
        popup: isPopup,
        position: typeof t.position === 'number' ? t.position : (idx + 2),
        claims: { tabBtnId: t.tabBtnId, panelId: t.panelId || '' },
      });
    });
    delete c[legacyKey];
  };
  migrate('legacyNativeTabs', 'centerTabs');
  migrate('legacyNativeRightTabs', 'rightTabs');
}

function validateContributions(manifest) {
  const warnings = [];
  const c = manifest.contributions || {};
  const sdk = manifest.sdkVersion || 1;
  for (const key of Object.keys(c)) {
    if (!ALL_KNOWN_CONTRIBUTIONS.has(key)) {
      warnings.push(`unknown contribution '${key}'`);
      continue;
    }
    if (KNOWN_CONTRIBUTIONS_V2.has(key) && sdk < 2) {
      warnings.push(`contribution '${key}' requires sdkVersion >= 2 (manifest declares ${sdk})`);
    }
  }
  // Pinned/popup tabs must declare either claims (existing core DOM) or html
  // (iframe). Pinned and popup are mutually exclusive.
  ['centerTabs', 'rightTabs'].forEach(k => {
    if (!Array.isArray(c[k])) return;
    c[k].forEach(t => {
      if (!t) return;
      if (t.pinned && t.popup) {
        warnings.push(`${k} entry '${t.id}' declares both 'pinned' and 'popup' (mutually exclusive)`);
      }
      if ((t.pinned || t.popup) && !t.claims && !t.html) {
        warnings.push(`${k} entry '${t.id}' is ${t.popup ? 'popup' : 'pinned'} but has neither 'claims' nor 'html'`);
      }
    });
  });
  return warnings;
}

function checkActivation(manifest, getConfig) {
  const cond = manifest.activationConditions;
  if (!cond || cond.always) return true;
  if (cond.configKeys) {
    const config = getConfig();
    return cond.configKeys.every(key => !!config[key]);
  }
  return true;
}

module.exports = {
  KNOWN_CONTRIBUTIONS_V1, KNOWN_CONTRIBUTIONS_V2, ALL_KNOWN_CONTRIBUTIONS,
  normalizeLegacyShapes, validateContributions, checkActivation,
};
