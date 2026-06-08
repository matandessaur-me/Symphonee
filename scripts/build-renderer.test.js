'use strict';
// Renderer build-integrity guards.
//
// app.js is a GENERATED file (flat concatenation of parts/ per manifest.json).
// Nothing enforced that the committed app.js actually matched its source, so a
// hand-edit or a forgotten rebuild could silently ship stale renderer code --
// exactly the failure mode that makes "edit a part, nothing changes" bugs.
// These tests make the generated/source relationship a hard invariant, and lock
// in the pinned-tabs module extraction (first slice off the flat app.js).
//
// Run: node --test scripts/build-renderer.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'dashboard', 'public');
const PARTS = path.join(PUB, 'app', 'src', 'parts');
const APP_JS = path.join(PUB, 'js', 'app.js');

const manifest = () => JSON.parse(fs.readFileSync(path.join(PARTS, 'manifest.json'), 'utf8'));

test('app.js is the byte-exact concatenation of the manifest parts (no drift)', () => {
  const out = manifest().map(p => fs.readFileSync(path.join(PARTS, p), 'utf8')).join('');
  const committed = fs.readFileSync(APP_JS, 'utf8');
  assert.equal(out, committed,
    'dashboard/public/js/app.js is out of sync with parts/. Run `node scripts/build-renderer.js`.');
});

test('every manifest entry exists as a part file', () => {
  for (const p of manifest()) {
    assert.ok(fs.existsSync(path.join(PARTS, p)), `manifest references missing part: ${p}`);
  }
});

test('no part is orphaned: every parts/*.js is listed in the manifest', () => {
  const inManifest = new Set(manifest());
  for (const f of fs.readdirSync(PARTS).filter(f => f.endsWith('.js'))) {
    assert.ok(inManifest.has(f),
      `parts/${f} exists but is not in manifest.json -- it would not be built into app.js`);
  }
});

// ── Extraction contract: each leaf carved off app.js is a real ES module ─────
// One entry per slice off the flat app.js. Adding the next slice = add a row.
//   part:    former parts/ filename (must be gone from parts/ and the manifest)
//   src:     module source entry (relative to dashboard/public)
//   out:     built bundle served by index.html (relative to dashboard/public)
//   exposes: globals it re-attaches to window for the still-flat app.js to call
//   gone:    function names that must NO LONGER be defined inside app.js
// `part` set => a leaf carved out of parts/ (must be gone from parts/ + manifest).
// `part` omitted => a new shared module (e.g. util) that merely owns globals the
// flat parts used to define; only the `gone`/`exposes`/wiring checks apply.
const EXTRACTED = [
  {
    part: 'pinned-tabs.js', src: 'pinned-tabs/src/index.js', out: 'js/pinned-tabs.js',
    exposes: ['getSavedTabOrderOverrides', '_placeTabAtEnd'], gone: ['_placeTabAtEnd', '_initTabDrag'],
  },
  {
    part: 'local-model-prompt.js', src: 'local-model-prompt/src/index.js', out: 'js/local-model-prompt.js',
    exposes: ['symphEnsureLocalModel'], gone: ['symphEnsureLocalModel', '_symphModelModal'],
  },
  {
    name: 'util', src: 'util/src/index.js', out: 'js/util.js',
    exposes: ['escapeHtml'], gone: ['escapeHtml'],
  },
  {
    part: 'mcp.js', src: 'mcp/src/index.js', out: 'js/mcp.js',
    exposes: ['refreshMcpServers', 'addMcpServer', 'toggleMcp', 'refreshMcp', 'removeMcp'],
    gone: ['refreshMcpServers', 'addMcpServer', 'renderMcpServerCard'],
  },
  {
    part: 'notes-search.js', src: 'notes-search/src/index.js', out: 'js/notes-search.js',
    exposes: ['onNotesSearchInput', 'openNoteFind', 'closeNoteFind', 'updateNoteFindMatches',
      'noteFindStep', 'syncNoteHighlightScroll', 'updateNoteHighlightsLive', 'onNoteFindKeydown'],
    gone: ['runNotesSearch', 'paintNoteHighlights', 'noteFindHighlight'],
  },
  {
    part: 'permissions.js', src: 'permissions/src/index.js', out: 'js/permissions.js',
    exposes: ['openPermModeMenu', 'setPermMode', 'resolveApproval', 'resolveGraphApproval'],
    gone: ['refreshPermMode', 'pollApprovals', 'showApprovalModal'],
  },
  {
    part: 'activity-timeline.js', src: 'activity-timeline/src/index.js', out: 'js/activity-timeline.js',
    exposes: ['openActivityTimeline', 'closeActivityTimeline', 'setTimelineRange', 'renderTimeline'],
    gone: ['getTimelineItems', 'entryMeta', 'renderTimelineCharts'],
  },
  {
    part: 'activity-ledger.js', src: 'activity-ledger/src/index.js', out: 'js/activity-ledger.js',
    exposes: ['openHistory', 'ledgerLoad', 'ledgerSetFilter', 'ledgerCheckpointNow', 'ledgerUndo',
      'ledgerOnAction', 'ledgerOnActionPatch'],
    gone: ['ledgerRender', 'ledgerRenderCheckpoints', '_ledgerRowHtml'],
  },
  // browser-credentials.js was a mixed file; split into two cohesive modules.
  {
    part: 'browser-credentials.js', src: 'browser-credentials/src/index.js', out: 'js/browser-credentials.js',
    exposes: ['renderBrowserCreds', 'addBrowserCredential', 'addBrowserCredentialBrowserTab',
      'removeBrowserCredential', 'refreshBrowserSettings', 'saveBrowserSettings'],
    gone: ['_renderBrowserCredsInto', 'browsePlugins', 'installFromRegistry'], // registry fns moved OUT of app.js too
  },
  {
    name: 'plugin-registry', src: 'plugin-registry/src/index.js', out: 'js/plugin-registry.js',
    exposes: ['browsePlugins', 'filterRegistry', 'installFromRegistry', 'updatePlugin',
      'uninstallPlugin', 'installPluginPrompt', 'closeRegistryModal', 'savePluginSettings',
      'loadPluginRecommendations', 'sortPluginsWithRecommendations'],
    gone: ['renderRegistryList', 'markRegistryNeedsRestart'],
  },
  {
    part: 'themes.js', src: 'themes/src/index.js', out: 'js/themes.js',
    exposes: ['renderThemeList', 'applyBuiltinTheme', 'applyCustomTheme', 'editThemeInEditor',
      'deleteTheme', 'toggleThemeEditor', 'saveCustomThemeFromEditor', 'exportThemes', 'importThemes',
      'restoreCustomTheme', '_setThemeMode',
      // shared constants other parts read at runtime:
      'BUILTIN_THEMES', 'ALL_CSS_KEYS', 'ACTIVE_THEME_KEY'],
    gone: ['generateThemeVars', 'getSavedThemes', '_loadThemesFromServer'],
  },
  {
    part: 'notifications.js', src: 'notifications/src/index.js', out: 'js/notifications.js',
    exposes: ['notify', 'openActivityStats', '_notifToggleSound', 'playNotifSound',
      '_showPaletteDispatchToast', '_schedulePaletteDispatchToast', '_clearPaletteDispatchToast',
      'notifClearAll', '_focusInlineReply', '_inlineReplySend', 'renderReplyChip', 'toggleNotifPanel',
      '_cancelFollowup',
      // shared task-tracking Set mutated by command-palette + orchestrator:
      '_paletteNotifyTasks'],
    gone: ['_loadNotifs', 'renderNotifBadge'],
  },
  {
    part: 'pull-requests.js', src: 'pull-requests/src/index.js', out: 'js/pull-requests.js',
    exposes: ['populatePRsRepoSelect', 'loadPRs', 'viewPR', 'selectPRFile', 'openPRCommentModal',
      'closePRCommentModal', 'submitPRCommentModal', 'addPRComment', 'submitPRReview',
      'openRequestChangesModal', 'closeRequestChangesModal', 'submitRequestChanges'],
    gone: ['renderPRList', 'renderPRDetail', 'renderPRTimeline'],
  },
  {
    // Bundled from 3 former parts; no single `part` file. Checks the bundle is
    // built, exposes its surface, served, and the 3 parts are gone from the manifest.
    name: 'browser', src: 'browser/src/index.js', out: 'js/browser.js',
    exposes: ['sendBrowserAgent', 'stopBrowserAgent', 'toggleBrowserAgentPanel', 'inappBrowserGo',
      'inappBrowserReload', 'closeInappToolsPanel', 'handleBrowserAgentStep', 'handleBrowserRouterDispatch',
      'handleStagehandScreencast', '_resetAllEmulation', '_runInappSiteAudit', '_runInappReaderView',
      'applyInappBrowserAppearance'],
    gone: ['_ensureInappBrowser', '_renderInappToolsMenu', '_runInappEmulatePanel'],
  },
  {
    name: 'apps', src: 'apps/src/index.js', out: 'js/apps.js',
    exposes: ['appsOpenLauncher', 'appsOpenAutomations', 'appsRefreshAll', 'appsRefreshWindows',
      'appsChatSend', 'appsAutomationsNew', 'appsAutomationsSave', 'appsAutomationsRunNow',
      'appsAutomationsGenerate', 'appsPanic', 'handleAppsAgentStep', 'appsSubmitAdd',
      '_appsBuilderDragStart', '_appsComSubmit'],
    gone: ['_appsRenderBuilderRows', '_appsAutomationsShowForm'], // internal cross-cluster helpers (private in the bundle)
  },
  {
    part: 'settings.js', src: 'settings/src/index.js', out: 'js/settings.js',
    exposes: ['openSettings', 'closeSettings', 'switchSettingsTab', 'saveSettings', 'openCreateModal',
      'submitCreateWorkItem', 'addProjectFromSettings', 'setActiveProject', 'deleteRepoFromSettings',
      'repoAddBrowse', 'renderCloneSourceButtons', 'openFactoryResetModal', 'factoryResetConfirm',
      'exportSettings', 'importSettings',
      // shared install-in-progress Set used by onboarding.js:
      '_aiInstalling'],
    gone: ['detectAiTools', 'renderAiTools', 'installCli'],
  },
  {
    part: 'plugins.js', src: 'plugins/src/index.js', out: 'js/plugins.js',
    exposes: ['notifyPluginIframes', 'registerPluginTab', 'applyPluginPinnedTabs', 'injectPinnedCenterTab',
      'openPluginTab', 'ensurePluginTabOpen', 'reconcilePluginShellSurfaces', 'refreshPluginActivation',
      'injectSidebarAction', 'injectAiAction', 'runPluginAiAction', 'injectIntelPanel',
      '_syncPluginToggleVisual', '_populatePluginSettingOptions', 'switchPluginSettingsTab',
      'toggleSecretField'],
    gone: ['executePluginAction', '_pluginActionSubst', 'injectCenterTab'],
  },
  {
    part: 'command-palette.js', src: 'command-palette/src/index.js', out: 'js/command-palette.js',
    exposes: ['openCmdPalette', 'openAIFocusPalette', 'openShortcutHelp', 'askAIFromPalette',
      'closeCmdPalette', 'filterCmdPalette', 'openRepoMapModal', 'setRepoMapView', 'copyRepoMap',
      'saveRepoMapAsNote', 'analyzeActiveRepo', 'cmdPaletteKeydown', 'loadPluginCmdItems'],
    gone: ['renderMarkdownToHtml'], // private markdown helper (distinct from the app-wide renderMarkdown)
  },
  {
    part: 'work-items.js', src: 'work-items/src/index.js', out: 'js/work-items.js',
    exposes: ['loadConfig', 'loadIterations', 'pushUiContext', 'currentNotesNs', 'notesFetch',
      'loadWorkItems', 'renderBoard', 'renderBacklog', 'viewWorkItem', 'onCardDragStart',
      'onCardDragEnd', 'highlightFamily', 'applyBacklogFilters', 'addWIComment', 'startWorking',
      'loadVelocity', 'loadTeams', 'loadAreas'],
    gone: ['boardCardHtml', 'childRollupHtml', 'updateActivityFeed'],
  },
  {
    part: 'spaces-repos.js', src: 'spaces-repos/src/index.js', out: 'js/spaces-repos.js',
    exposes: ['isCoreSpacePluginId', 'openAddSpaceDialog', 'openEditSpaceDialog', 'deleteSpace',
      'renderSettingsSpaces', '_repoNamesForSpace', 'loadRepoList', 'loadGitStatusForDiffTab',
      'selectRepo', 'selectSpace', '_msSwitchTab', '_saveManageSpace', 'applyPluginSpaceFilter',
      // shared Set used by plugins.js:
      'CORE_SPACE_PLUGIN_IDS'],
    gone: ['_refreshSpaceSwitcher', 'startGitStatusPolling', 'openManageSpaceDialog'],
  },
  {
    part: 'notes.js', src: 'notes/src/index.js', out: 'js/notes.js',
    exposes: ['loadNotesList', 'openNote', 'setNoteMode', 'saveCurrentNote', 'confirmCreateNote',
      'sendNoteToAi', 'exportCurrentNote', 'importNotesFromFile', 'customConfirm', 'customPrompt',
      'closeConfirm', 'closePrompt', 'showNoteContextMenu', 'showFileTreeContextMenu',
      'deleteNoteFromContext', 'renameNoteFromContext', 'duplicateNoteFromContext'],
    gone: ['deleteNote', 'revealPath', '_insertNoteMention'],
  },
  {
    part: 'files.js', src: 'files/src/index.js', out: 'js/files.js',
    exposes: ['populateFilesRepoSelect', 'loadFileTree', 'viewFile', 'toggleFilesEdit', 'loadMonaco',
      'viewCommitDiff', 'selectDiffFile', 'renderInlineDiff', 'closeDiffView', 'viewChangedFile',
      'saveFilesEdit', 'loadGitLogPanel', 'closeModal', 'openSpaceModal', 'openRepoModal',
      'doGitCheckoutFromModal'],
    gone: ['renderFilesBreadcrumb', 'createOrUpdateMonaco', 'renderDiffForFile'],
  },
  {
    part: 'git.js', src: 'git/src/index.js', out: 'js/git.js',
    exposes: ['openGitModal', 'closeGitModal', 'switchGitTab', 'loadGitBranches', 'renderGitBranches',
      'filterGitBranches', 'doGitCheckout', 'doGitPull', 'doGitPush', 'doGitCompare', 'setCommitMode',
      'doGitCommit', 'loadProjectScripts', 'runNpmScript', 'loadTerminalScripts'],
    gone: ['populateCompareDropdowns', 'loadCommitFileList', 'hlExtMap'],
  },
];

for (const m of EXTRACTED) {
  const label = m.part || m.name;
  test(`${label} is a real ES module (sourced as a module, wired in index.html)`, () => {
    if (m.part) {
      assert.ok(!fs.existsSync(path.join(PARTS, m.part)), `parts/${m.part} should be deleted (moved to ${m.src})`);
      assert.ok(!manifest().includes(m.part), `${m.part} must not be in the concat manifest`);
    }
    assert.ok(fs.existsSync(path.join(PUB, m.src)), `module source missing at ${m.src}`);
    const indexHtml = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes(`<script src="/${m.out}"></script>`), `index.html must load /${m.out}`);
  });

  test(`app.js no longer defines functions owned by ${label}`, () => {
    const app = fs.readFileSync(APP_JS, 'utf8');
    for (const fn of m.gone) {
      assert.doesNotMatch(app, new RegExp(`function ${fn}\\b`), `app.js still defines ${fn}`);
    }
  });

  test(`built ${m.out} re-exposes its public surface on window`, () => {
    const built = path.join(PUB, m.out);
    assert.ok(fs.existsSync(built), `${m.out} not built -- run \`node scripts/build-renderer.js\``);
    const mod = fs.readFileSync(built, 'utf8');
    for (const fn of m.exposes) {
      assert.match(mod, new RegExp(`window\\.${fn}\\s*=`), `${m.out} missing window.${fn}`);
    }
  });

  // The server allow-lists static files (no generic /js/ serving), so an
  // unregistered bundle 404s in the real app even though every unit test passes.
  test(`server.js ROUTES serves /${m.out}`, () => {
    const server = fs.readFileSync(path.join(ROOT, 'dashboard', 'server.js'), 'utf8');
    assert.ok(server.includes(`'/${m.out}':`),
      `server.js is missing the '/${m.out}' static route -- the bundle will 404 and its window.* exports never define`);
  });
}
