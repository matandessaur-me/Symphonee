# Plugin-First Shell - Changelog and Before/After

Branch: `feature/plugin-first-shell` -> merging into `master`
Commits: 46 | Files changed: 35 | Diff: +2248 / -2403 (net -155 lines)

## Architecture: before vs after

### Before (master)

DevOps Pilot was a monolithic dashboard that shipped Azure DevOps and GitHub as first-class, hardcoded integrations:

- `server.js` (3455 lines) hosted every work-item / iteration / team / PR / pull-request handler directly. Azure DevOps helpers (`adoRequest`, `getTeamAreaPaths`), GitHub helpers (`ghRequest`, `parseGitHubRemote`), SWR caches for both services, and all the route dispatch logic lived in core.
- `scripts/` shipped 11 PowerShell scripts for ADO / GitHub operations (`Find-WorkItems`, `Get-SprintStatus`, `New-PullRequest`, `Push-AndPR`, ...).
- `SENSITIVE_KEYS = ['AzureDevOpsPAT', 'GitHubPAT', ...]` hardcoded the service keys for export/import stripping.
- `handleImageProxy` had an `if (pat && hostname.includes('dev.azure.com'))` branch that baked ADO auth into the generic image proxy.
- `config.json` stored all integration secrets at the root; plugins had no config storage of their own.
- `/api/instructions` served the ADO / GitHub reference tables unconditionally -- AI agents were taught about work items even on installs where those concepts didn't apply.
- Onboarding required Azure DevOps org / project / PAT to be "complete". Users who needed only a local-terminal workflow couldn't finish onboarding cleanly.
- The settings modal had dedicated "Azure DevOps" and "Other / GitHub" tabs alongside the generic Plugins tab.
- Backlog / Work Item / Pull Requests / Activity / Teams / Git Log tabs were always present, gated only on whether their config keys were set.
- The command palette hardcoded Azure DevOps and GitHub commands, shown/hidden with `if (hasAdo)` / `if (hasGh)` booleans.

A Jira, Wrike, or GitLab user installing DevOps Pilot saw a UI full of Azure-flavored surfaces they would never use and an AI that insisted `AB#` commit conventions were mandatory.

### After (feature/plugin-first-shell)

DevOps Pilot is now a shell. Core keeps terminal, files, diff viewer, notes, recipes, git primitives, orchestrator, AI instructions, settings, export/import, factory reset, permissions. **Azure DevOps and GitHub are plugins** -- installed from the same registry (`matandessaur-me/devops-pilot-plugins`) as Builder.io, Sanity, WordPress, and any future integration.

- `server.js` (2681 lines, -774 lines) has zero ADO or GitHub handlers. Every `/api/workitems/*`, `/api/iterations`, `/api/teams`, `/api/areas`, `/api/velocity`, `/api/burndown`, `/api/team-members`, `/api/start-working`, `/api/github/*`, `/api/pull-request` route is owned by its plugin via `ctx.addAbsoluteRoute`. Uninstall the plugin -> routes 404 with `{ pluginRequired }` JSON.
- `scripts/` (17 files, -11 ADO/GitHub scripts + 1 new `Get-PluginInstructions.ps1`) ships only generic tooling. ADO/GitHub scripts moved into their plugin repos.
- `SENSITIVE_KEYS` aggregates from every plugin's `contributions.sensitiveKeys` at runtime. Core owns only `WhisperKey` and `AiApiKeys`. Third-party plugins opt in automatically.
- `handleImageProxy` has no hostname knowledge. Plugins contribute `contributions.imageAuth: [{ hostnamePattern, authType, authConfigKey }]`. Core walks the contributed rules.
- Plugin-local `config.json` persists keys declared in `contributions.configKeys`. Main `config.json` surfaces them via a merge for backward compat; future writes land in the plugin's own file.
- `/api/instructions` strips `<!-- ADO_START -->` / `<!-- GH_START -->` marker blocks at runtime based on plugin activation. AI on a plugin-less install sees zero references to Azure DevOps, GitHub, work items, AB#, or pull requests.
- Onboarding is plugin-first: step 2 detects installed AI CLIs, step 3 browses the plugin registry (with context-aware recommendations from `/api/plugins/recommendations` scanning local git remotes), step 4 is an optional ADO setup, step 5 is an optional GitHub setup, step 6 is the overview. A "Just the terminal" shortcut jumps past optional steps.
- Settings modal has a single Plugins tab. The ADO and GitHub panels live there via `nativeSettings` claiming the existing DOM blocks -- saving still writes through the same IDs, so no config migration was needed.
- Tab visibility is plugin-driven. `legacyNativeTabs` / `legacyNativeRightTabs` contributions let a plugin claim core-rendered tabs (Backlog / PR / Work Item / Activity / Teams / Git Log). Uninstall -> tabs disappear. Future iframe-backed `centerTabs` / `rightTabs` open as closable tabs for truly plugin-owned UI.
- Command palette reads from `_loadedPlugins`, iterating every installed plugin's `leftQuickActions` / `aiActions` / `legacyNativeTabs`. Categories are plugin names, not hardcoded strings.
- Factory reset button in the settings modal header: one-click wipe of config, themes, notes, recipes, learnings, display prefs, and every installed plugin, with an "Export first" option.
- No upgrade auto-install. Pre-plugin-first users restart with no ADO/GitHub plugin and pick what they want from the onboarding plugin store. Anyone who wants their old config back can Export first / Import after, which restores configs and re-clones the plugins they actually used.

A clean install is now a minimal AI terminal with files / notes / recipes / orchestrator. Users pick their integrations.

### Line-level comparison (selected)

| File | Before | After | Delta |
|---|---|---|---|
| `dashboard/server.js` | 3455 | 2681 | -774 |
| `dashboard/public/index.html` | 12828 | 13483 | +655 (plugin-first wiring, onboarding Plugins step, factory reset, contributions-client integration) |
| `scripts/*` | 27 files | 17 files | -10 (ADO/GitHub moved to plugin repos) |

## New plugin SDK (v2.1)

Added contribution types:

- `leftQuickActions` - sidebar buttons
- `rightTabs` / `centerTabs` - iframe-backed tab content
- `legacyNativeTabs` / `legacyNativeRightTabs` - claim existing core-rendered tabs (first-party only; third parties should render their own iframes)
- `repoSources` - register a "Clone from X" provider in the repos modal
- `commitLinkers` - regex + `urlTemplate` for auto-linking commit messages
- `workItemProvider` / `prProvider` - standardized interfaces so a Jira / Wrike / GitLab plugin can drop into the generic Backlog / PR flow
- `aiActions` - AI quick actions (standup, retro, etc.) with `{ script, args, analyze, requires, prompt }` shape
- `nativeSettings` - claim an existing settings DOM block so the plugin owns that settings panel
- `sensitiveKeys` - config keys to strip on export and preserve on import
- `imageAuth` - URL-pattern auth injection for `/api/image-proxy`
- `configKeys` - keys this plugin owns; persisted to plugin-local config.json, merged into main config for compat
- `mcp` - MCP tool definitions (the MCP server now builds its tool list entirely from plugins)

New SDK primitives on `ctx`:

- `ctx.addAbsoluteRoute(method, path, handler)` + `ctx.addAbsolutePrefixRoute(path, handler)` - plugin owns URLs outside its `/api/plugins/<id>/` prefix
- `ctx.shell.*` - shell helpers: `gitExec`, `sanitizeText`, `permGate`, `incognitoGuard`, `getRepoPath`, `repoRoot`, `https`, `fs`, `path`, `execSync`, `spawnSync`, `SWRCache`, `broadcast`
- `ctx.cache` - SWR cache for the plugin's own data
- `GET /api/plugins` (canonical manifest list) + `GET /api/plugins/contributions` (typed aggregation view) + `GET /api/plugins/<id>/config` (generic plugin config store)

## New core features

- `GET /api/plugins/recommendations` - scans configured repo git remotes and suggests plugins by host
- `POST /api/notes/export-all`, `GET /api/notes/export`, `POST /api/notes/import` - per-note and bulk note transfer
- `POST /api/config/reset` - factory reset
- Export bundle now covers `_notes`, `_recipes`, `_learnings`, `_themes`, `_pluginConfigs`, `_displayPref`
- Import auto-clones missing plugins from the registry using the plugin IDs found in `_pluginConfigs`
- `Get-PluginInstructions.ps1` script + `/api/plugins/instructions` endpoint so the AI can fetch plugin-contributed guidance on demand
- `reconcilePluginShellSurfaces()` - single atomic pass that gates sidebar sections, tabs, intel tabs on plugin presence (replaces scattered `hasAdo` / `hasGh` booleans)
- `refreshPluginActivation()` + auto-restart when saving settings flips a plugin's activation state
- Structured `{ error, hint, pluginRequired }` 404 for URLs that would be owned by an uninstalled plugin
- 3 shell-only default recipes: `explain-codebase`, `what-changed-recently`, `find-todos`, plus the `smoke-test-shell` validation recipe

## Plugin repos published

Both first-party plugins ship as their own git repositories and are listed in the shared registry:

| Plugin | Repo | Version |
|---|---|---|
| Azure DevOps | `M8N-MatanDessaur/devops-pilot-plugin-azure-devops` | v0.6.1 |
| GitHub | `M8N-MatanDessaur/devops-pilot-plugin-github` | v0.6.1 |

Each plugin ships: `plugin.json`, `routes.js` (handler implementations), `instructions.md` (AI guidance), `scripts/` (its PowerShell utilities), `README.md`.

## Migration path for existing users

Users upgrading from master with `AzureDevOpsPAT` or `GitHubPAT` in their `config/config.json`:

1. First startup after merge detects legacy config keys without matching plugin.
2. Server clones the plugin from the registry silently.
3. Log line: `Migration: installed azure-devops. Restart to activate.`
4. User restarts once. Everything works identically to before.

Users without those keys in config see no migration -- they're on the clean plugin-first path from the start.

## Commit-by-commit highlights

Setup and planning:
- `8b18250` Plan + SDK extension skeleton + smoke-test recipe

Contribution system groundwork:
- `48a5771` Plugin manifests for ADO, GitHub, GitLab, Jira (initial stubs)
- `fb88e9c` `contributions-client.js` loaded from index.html
- `7329fbc` `providerFetch` + dormant UI helpers
- `95c3134` `nativeTabs` SDK primitive
- `cbc2ad1` Plugin SDK v2.1: `addAbsoluteRoute` + `ctx.shell` helpers

UI refactor:
- `f3ead5f`, `f3e457a` Settings relocation via `nativeSettings`
- `265ecd3` Right-column tab gating + core quick actions
- `345c3d9` Command palette gating on plugin presence
- `5639d5a` Onboarding "Install Plugins" step
- `3e763b2` Plugin-driven sidebar (no more duplicate buttons)
- `befde5a` Plugin-drive command palette entirely from contributions

Export / import / factory reset:
- `4aff5e2` Notes / recipes / learnings / display prefs in export
- `5625708`, `0ead560` Factory reset UI
- `bcba1ca` `sensitiveKeys` + `imageAuth` contributions
- `046e990` Plugin-local `config.json` via `configKeys`
- `1fc0af5` Upgrade auto-install migration

Server extraction:
- `012be24` Scripts moved to plugin repos
- `4488bda` Route gates + instruction stripping
- `2cfbdff` GitHub handlers moved to plugin v0.4.0 (-486 lines)
- `d370f78` Azure DevOps handlers moved to plugin v0.4.0 (-1034 lines)
- `840721c` Structured plugin-required 404 for extracted routes

Fixes along the way:
- `cc07d02`, `294e49c`, `0381ccf`, `a05b201`, `e597c14`, `8d3165c` Cold-start plugin activation race (resolved with `reconcilePluginShellSurfaces`)
- `ef676cb` `runPluginAiAction` supports `args` / `requires` / templating
- `6678f6c` Orchestrator: auto-scroll live outputs + force-submit task results
- `f732ea5` Restore `sanitizeText` (caught by audit)
- `befde5a` Registry hang (async prefix dispatcher bug)
- Plugin v0.6.1 reverts `rightTabs` -> `legacyNativeRightTabs` for intel tabs

## Pre-merge polish pass (2026-04-15)

User feedback on the six-point list resolved as follows:

1. **Pinned + popup + ephemeral are now first-class SDK.** `legacyNativeTabs` / `legacyNativeRightTabs` are gone from the public docs. Plugins declare `centerTabs` / `rightTabs` entries with one of: `pinned: true` (always-visible, non-closable, declared `position`), `popup: true` (hidden by default, opened by a plugin/core action like `viewWorkItem` or `openActivityTimeline`, closable via an injected X), or neither (ephemeral, openable from the + menu). All non-ephemeral tabs use either `claims: {tabBtnId, panelId}` (own core DOM) or `html: "..."` (plugin-shipped iframe). Position ties break alphabetically by `pluginId:tabId`. Core pinned tabs occupy fixed positions (Terminal=0, Orchestrator=1, Files=900, Notes=901). The shell accepts the old key names as an internal alias: legacy entries with `openable: false` (Work Item, Activity Timeline) become popup tabs; entries with `openable: true` become pinned tabs.
2. **Hot reload deferred.** Restart-on-activation-change is the contract. Implementing in-process route teardown carries unbounded risk for low value when restart already works; revisit if a plugin author requests it.
3. **Sandbox dropped from scope.** Plugins are first-party / trusted-store installs; in-process is intentional.
4. **Multi-registry dropped from scope.** Store concern, not plugin-first-shell.
5. **Dead code removed.** `runScript()` deleted (zero callers). The applyNativeTabClaims path was rewritten as `applyPluginPinnedTabs` which reads the new pinned-tab shape. `hasAdo` / `hasGh` config-key checks in `loadConfig()` now derive from plugin presence (`workItemProvider` / `prProvider` contributions) instead of probing root config keys, cutting the last config-driven coupling. Stale comments referring to the legacy keys updated.
6. **Tab position + alphabetical tie-break shipped.** Same mechanism as point 1.

Updated files:
- `dashboard/plugins/sdk/CONTRIBUTIONS.md` -- rewritten with the pinned/ephemeral split, position rules, and worked example.
- `dashboard/plugin-loader.js` -- normalizes legacy contribution keys, validates pinned tabs require either `claims` or `html`.
- `dashboard/public/index.html` -- `applyPluginPinnedTabs`, position-driven flex `order`, `runScript` deleted, plugin-presence checks replace config-key checks.
- `dashboard/plugins/azure-devops/plugin.json` and `dashboard/plugins/github/plugin.json` -- migrated to the new pinned-tab shape (synced to the source-of-truth repos under `C:/Code/Personal/DevOpsPilot-Plugins/`).

## Codex-audit resolution pass (2026-04-15)

After the first polish pass, Codex reviewed the branch and flagged five gaps between "ADO/GitHub are plugins" (achieved) and "DevOps Pilot is provider-pluggable" (the revamp promise). All five are resolved in this pass:

1. **Provider routing is now end-to-end.** Every PR and work-item call in `index.html` goes through `DevOpsPilot.contributions.providerFetch(kind, routeField, opts)`:
   - PR: `detailRoute`, `filesRoute`, `timelineRoute`, `commentRoute`, `reviewRoute`, `listRoute`.
   - Work item: `getRoute`, `updateStateRoute`, `commentRoute`, `startWorkingRoute`, `listRoute`, `createRoute`, `iterationsRoute`, `teamsRoute`, `areasRoute`, `teamMembersRoute`, `velocityRoute`, `burndownRoute`.
   - Legacy `|| fetch('/api/github/...' or '/api/workitems...')` fallbacks removed. When no provider is installed, the call returns a user-facing empty state.
   - Net effect: a Jira / GitLab / Wrike plugin that implements the `workItemProvider` / `prProvider` route-field interface is a drop-in replacement; no core edits needed.

2. **Clone UI is generic across `repoSources`.** The old `_fetchGitHubRepos` / `_renderGitHubRepoList` / `_showGitHubPicker` / `_ghRepoSelected` / `repoAddGitHubClone` functions were rewritten as `_fetchPluginRepos(source, ...)` / `_renderPluginRepoList(source, ...)` / `_showPluginClonePicker(source, ...)` / `_pluginRepoSelected(sourceId, ...)` / `repoAddPluginClone(sourceId, ...)`. A new `renderCloneSourceButtons(containerId, ctx, btnClass)` loops contributed `repoSources` and paints one "Clone from X" button per source. Settings > Repositories and Onboarding step 5 now have no hardcoded buttons; buttons appear as plugins contribute. Legacy GitHub function names kept as aliases.

3. **Command palette single pass.** The duplicate second loop (previously at ~line 10803) has been deleted. `leftQuickActions`, `aiActions`, and pinned `centerTabs` are now added exactly once. Claimed/popup tabs are no longer wrongly routed through `openPluginTab` -- pinned tabs with `claims.tabBtnId` resolve to `switchTab(dataTab)` via the button's `data-tab` attribute.

4. **Work-item shortcuts are gated on provider presence.** Ctrl+B, Ctrl+R, Ctrl+Shift+N, and Ctrl+Shift+F short-circuit unless a `workItemProvider` is installed. A clean install where the user never added ADO/Jira/etc. has these shortcuts as no-ops instead of firing into the void. `getCmdActions()`'s `hasAdo` / `hasGh` flags now derive from `workItemProvider` / `prProvider` contributions, not plugin ids.

5. **Settings > Plugins exposes installed-inactive plugins.** New endpoint `GET /api/plugins/installed` returns every installed plugin with an `active: bool` flag. `initPlugins()` uses this for `renderPluginSettings()` so users can configure an installed-but-unconfigured first-party plugin (where activation requires config keys like `AzureDevOpsPAT`). Saving the config flips activation and triggers the existing `refreshPluginActivation -> restart` flow. `/api/plugins` still returns active-only for route registration and palette iteration, so behavior is unchanged elsewhere.

**Residual ADO/GitHub wording cleanup:**
- `config/config.template.json` no longer ships `AzureDevOpsOrg`, `AzureDevOpsProject`, `AzureDevOpsPAT`, `DefaultTeam`, `DefaultUser`, or `GitHubPAT`. Those keys belong to their plugins' `configKeys` and are written to plugin-local `config.json`.
- Incognito-mode description no longer names Azure DevOps or GitHub specifically -- reads "external provider connections".
- `settingsSection-github` (the GitHub section in the Other tab) and `settingsTab-ado` are hidden by default (`style="display:none"`). The native-settings mount unhides them only when the owning plugin is installed. Without the plugin, core has no GitHub/ADO-specific UI.

**Files touched in this pass:**
- `dashboard/public/index.html` -- provider routing, generic clone UI, single-pass palette, gated shortcuts, installed-plugin settings flow, hidden GH/ADO sections.
- `dashboard/plugin-loader.js` -- new `/api/plugins/installed` endpoint.
- `config/config.template.json` -- legacy ADO/GitHub keys removed.
- `docs/CHANGELOG-plugin-first-shell.md` -- this section.

## Codex-audit second pass (2026-04-15, follow-up)

Codex ran a second audit after the first resolution pass and flagged five remaining leaks. All resolved here:

1. **Upgrade migration preserved.** `dashboard/plugins/*` is gitignored (only the SDK is tracked) so a user upgrading from master does not get the plugin folders in-tree. The auto-install IIFE in `dashboard/server.js` that clones `azure-devops` / `github` from the registry when legacy root-config keys (`AzureDevOpsPAT`, `GitHubPAT`) are detected has been restored (it had been deleted from the working tree pre-audit). Existing master users continue to work after `git pull`.
2. **Installed-inactive settings render in the zero-active case.** The `/api/plugins/installed` fetch used to sit inside `if (plugins.length)`, so a clean install with only unconfigured first-party plugins showed nothing in Settings > Plugins. Moved the fetch out of the guard so the installed list always populates.
3. **Start Working prompt no longer literals `/api/workitems/`.** The AI prompt now resolves the active `workItemProvider.getRoute` from contributions client-side and substitutes `:id`. Fallback instructs the AI to look up the route via `/api/bootstrap` if no provider is resolvable. The "Open in ADO" button label reads from the active provider's `label` field; defaults to "Open in provider" as a safety net.
4. **Onboarding is plugin-driven.** Step 4 (Azure DevOps config) is tagged `_requires: 'azure-devops'` and skipped unless the plugin is installed. Step 6 (GitHub + Whisper) conditionally renders the GitHub section only when the github plugin is present; Whisper is core and always shown. `_obStepIsApplicable` / `_obNextApplicable` walk the steps list skipping gated steps in both directions; progress dots reflect only applicable steps. A Jira-only or "no code host" install sees onboarding without ADO/GitHub forms.
5. **PR copy is provider-labeled.** "Open on GitHub" / "Merge on GitHub" buttons now read `'Open on ' + prProvider.label` / `'Merge on ' + prProvider.label` from the active provider contribution. The stale "GitHub API propagation" comment changed to "provider API propagation".

**Files touched in this pass:**
- `dashboard/server.js` -- restored auto-install migration (was git-clean before edit).
- `dashboard/public/index.html` -- installed-plugin fetch moved out of guard, Start Working prompt provider-routed, "Open in ADO" label dynamic, PR button labels dynamic, onboarding step gating + dot filtering.
- `docs/CHANGELOG-plugin-first-shell.md` -- this section.

## What stays deferred (not blocking merge)

- Physical extraction of Backlog / Work Item / PR HTML+JS out of `index.html` into plugin-shipped files. The SDK now supports it (`html: "..."` on a pinned tab), and small panels can move incrementally without further SDK changes. The current `claims`-based model satisfies the user's stated mental model ("part of index.html, almost like injecting it") so this is an internal cleanup, not a UX requirement.
- Plugin hot-reload (see point 2 above).

None of these affect correctness. They're follow-up tickets.
