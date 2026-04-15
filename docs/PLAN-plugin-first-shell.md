# Plan: Plugin-First Shell Architecture

Branch: `feature/plugin-first-shell`
Source note: `Next Big Plan For DevopsPilot`

## Goal

Turn DevOps Pilot into a **pure shell** with zero built-in integrations. Azure DevOps and GitHub become first-party plugins, equal in kind to Builder.io, Sanity, WordPress, etc. Users without ADO or GitHub (GitLab, Jira, Wrike users) can install only what they need. A clean install is just a terminal + quick actions + recipes; everything else is opt-in.

## Target shape

Three-column shell, fully plugin-populated:

- **Left column** - terminal + quick actions. Core keeps: terminal, repo list (local only), recipes launcher. Removed to plugins: backlog quick actions ("New item", "My item", "Refresh"), AI actions ("Stand up summary", "Iteration status", "Retrospective"). Kept in core: "Generate repo map".
- **Middle column** - tab host. Core keeps: Terminal, Files, Diff, Notes. Removed to plugins: Backlog, Work Item, Pull Request. Plugins can contribute any center tab (already supported via `contributions.centerTabs`).
- **Right column** - tab host. Core keeps: Recipes only. Removed to plugins: Teams, Activity, Git Log.

Settings modal: no separate ADO / GitHub tabs. Both become entries in the Plugins tab with their own settings pane (via `contributions.settingsHtml`).

## Current state (inventory of built-ins to extract)

Already plugin-shaped (keep as plugins): Builder.io, Sanity, WordPress, Env Manager, Dependency Inspector, Release Manager, GA4/GTM.

Hard-coded in core today (to be extracted):

1. **Azure DevOps**
   - Routes: `/api/workitems/*`, `/api/iterations`, `/api/teams`, `/api/areas`, `/api/activity`, velocity/sprint endpoints.
   - UI: backlog tab, work item tab, iteration dropdown, teams sidebar, activity sidebar, standup/retro/iteration-status AI actions.
   - Settings: dedicated ADO tab.
   - Quick actions: New Item, My Items, Refresh.

2. **GitHub**
   - Routes: `/api/github/*`, `/api/pull-request`, clone-from-GitHub.
   - UI: pull request tab, repos modal "clone from GitHub" button, git log sidebar.
   - Settings: dedicated GitHub tab.
   - Scripts: `Push-AndPR.ps1` etc.

3. **Shared behaviors** referenced by both
   - `AB#<id>` branch/commit auto-link (ADO + GitHub crosswalk).
   - Model router intents that assume ADO work items.
   - Learnings/recipes that mention ADO/GitHub by name.

## SDK gaps to fill

The existing plugin SDK supports `centerTabs`, `routes`, `settingsHtml`, `mcp`, and `aiKeywords`. To extract ADO and GitHub we need:

- `contributions.leftQuickActions` - array of `{id,label,icon,command}` injected into the left rail.
- `contributions.rightTabs` - mirror of `centerTabs` but targeting the right column (Teams, Activity, Git Log live here).
- `contributions.repoSources` - declare a repo provider (`name`, `clone` handler, `list` handler). The repos modal iterates all registered sources and renders a button per source.
- `contributions.commitLinkers` - declare a regex + resolver (e.g. `AB#\d+` -> ADO work item URL) so the ADO plugin re-contributes the auto-link behavior.
- `contributions.workItemProvider` - a single interface (`list`, `get`, `update`, `create`, `iterations`, `teams`, `activity`) so a Jira / Wrike / GitLab plugin can slot into the same backlog tab shell without re-building the UI.
- `contributions.prProvider` - analogous interface for pull requests so GitLab and Bitbucket plugins can contribute PR tabs identically to GitHub.
- `contributions.aiActions` - plugins register AI quick actions (standup, retro, iteration-status) instead of core hard-coding them.

Two of these (`workItemProvider`, `prProvider`) are the real leverage: they let a **generic Backlog tab** and **generic PR tab** live in core (or in a "provider-agnostic backlog" plugin), and each vendor plugin just implements the interface. That is the path to Jira / Wrike / GitLab plugins being drop-in replacements.

Open design question: do we keep one generic backlog tab in core that switches provider based on which work-item plugin is installed, or does each work-item plugin ship its own backlog tab? Recommendation: **generic tab in core, providers plug in**, because users with both ADO and Jira installed then get a unified board.

## Migration strategy (phased, each phase ships green)

Guiding rule: at every phase end, a user with ADO + GitHub plugins installed sees **exactly** today's app. No regressions.

### Phase 0 - Branch hygiene and safety net
- Feature branch already created: `feature/plugin-first-shell`.
- Add a smoke-test recipe that exercises: start app, open backlog, open a work item, open a PR, clone a repo, click standup action. Run this after every phase.

### Phase 1 - SDK extension
- Add the new contribution types (`leftQuickActions`, `rightTabs`, `repoSources`, `commitLinkers`, `workItemProvider`, `prProvider`, `aiActions`) to `plugin-loader.js` with no consumers yet.
- Update `dashboard/plugins/sdk/` (or create it if missing) with TypeScript/JSDoc types.
- Document each contribution point in `/api/plugins/instructions`.

### Phase 2 - Extract GitHub first (smaller surface than ADO)
- Create `dashboard/plugins/github/` with manifest.
- Move `/api/github/*` and `/api/pull-request` route handlers into the plugin's `routes.js`. Core keeps a thin shim that 410's with "install the GitHub plugin" if the plugin is missing, for one release, then removes the shim.
- Move the PR center tab into `contributions.centerTabs`.
- Move the git log right tab into `contributions.rightTabs`.
- Register the repos-modal "Clone from GitHub" button via `contributions.repoSources`.
- Move GitHub settings panel into the plugin via `contributions.settingsHtml`; remove the dedicated settings tab.
- Register `AB#` commit linker via `contributions.commitLinkers` (the ADO side of the link stays in core for now; removed in Phase 3).
- Run smoke-test recipe. Ship.

### Phase 3 - Extract Azure DevOps
- Create `dashboard/plugins/azure-devops/`.
- Move `/api/workitems/*`, `/api/iterations`, `/api/teams`, `/api/areas`, `/api/activity`, velocity endpoints.
- Contribute: backlog center tab (implemented against new `workItemProvider` interface, so the provider is the ADO plugin itself), teams right tab, activity right tab, iteration selector left action, AI actions (standup, iteration-status, retrospective), `leftQuickActions` for New Item / My Items / Refresh.
- Move ADO settings to the Plugins tab entry.
- Remove the dedicated ADO settings tab and the now-empty board/iteration area from the default shell.
- Move `AB#` linker fully into the ADO plugin.
- Smoke-test. Ship.

### Phase 4 - Generalize the backlog/PR tabs
- Promote the backlog tab out of the ADO plugin into core (or a `core-backlog` plugin that ships by default), driven by whichever `workItemProvider` is installed.
- Same for the PR tab.
- This is the payoff phase: now a Jira / Wrike / GitLab plugin only needs to implement the provider interface.

### Phase 5 - Write reference GitLab and Jira plugins (proof-of-concept)
- GitLab plugin: implements `prProvider` + `repoSources` (clone from GitLab).
- Jira plugin: implements `workItemProvider`.
- Even stub implementations prove the interfaces survive contact with real services.

### Phase 6 - First-run experience
- Update the onboarding flow: fresh install shows terminal + recipes, empty board/PR areas with a "Install Azure DevOps plugin" / "Install GitHub plugin" call-to-action.
- Settings modal: rebuilt Plugins tab is now the home for every integration; remove any remaining ADO/GitHub-specific settings UI.

## Risks and mitigations

- **Regression risk is high** because ADO+GitHub is the bulk of the UI. Mitigation: the smoke-test recipe at every phase, and Phase 2/3 ship the plugins as *bundled* (auto-enabled on upgrade) so existing users see no change.
- **Plugin SDK churn** - we are adding seven new contribution types. Mitigation: land them behind a `sdkVersion: 2` flag in `plugin.json` so current plugins keep working unchanged.
- **Performance** - plugin loader currently runs synchronously at startup. Adding seven contribution types per plugin multiplies the work. Mitigation: lazy-load right/center tab HTML on first activation (already the pattern), and keep manifest parsing O(plugins).
- **AI instructions drift** - the bootstrap payload, learnings, and recipes all mention ADO/GitHub by name. Mitigation: Phase 2/3 each include a pass on `dashboard/instructions/*` to replace hard-coded references with "if the ADO plugin is installed, ...".
- **Scripts** - `Push-AndPR.ps1`, `Show-Diff.ps1`, etc. assume GitHub. Mitigation: keep the filenames; move the GitHub-specific logic behind the plugin's API and have scripts call `/api/plugins/github/...` instead of `/api/github/...`.

## Acceptance criteria

- A fresh install with zero plugins shows: terminal, local repo list, recipes pane, quick action for "Generate repo map". Nothing else.
- Installing the Azure DevOps plugin restores the backlog tab, iteration selector, teams/activity sidebars, and standup/retro/iteration-status AI actions. Nothing less, nothing extra.
- Installing the GitHub plugin restores the PR tab, git log sidebar, "Clone from GitHub" button in the repos modal, and `Push-AndPR.ps1` behavior.
- Installing both reproduces today's UI pixel-for-pixel.
- A third-party plugin can implement `workItemProvider` and appear in the backlog tab without any core code changes.
- Settings modal has no ADO or GitHub tabs; both appear only under Plugins.

## Out of scope (for this branch)

- Actual Jira / Wrike / GitLab / Bitbucket plugins beyond the Phase 5 stubs.
- Plugin marketplace / remote install. Plugins remain filesystem-based.
- Auth refactor for multi-provider credentials (defer to a follow-up).

## Next step

Land Phase 0 (smoke-test recipe) and Phase 1 (SDK extension, no consumers). Review with user before starting Phase 2.
