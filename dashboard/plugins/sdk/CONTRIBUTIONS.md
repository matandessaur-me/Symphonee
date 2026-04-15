# Plugin Contribution Types

The `contributions` object in `plugin.json` tells DevOps Pilot what surfaces a plugin extends. The shell hosts a terminal, file tree, diff viewer, git, notes, recipes, and orchestrator. **Everything else is a plugin.**

Set `"sdkVersion": 2` in `plugin.json` to use any v2 contribution. v1 plugins continue to work unchanged.

---

## Tabs: pinned, popup, ephemeral

DevOps Pilot has two tab columns: the **center column** (main work area) and the **right intel column** (side panels). In both columns, a plugin tab is one of three kinds:

### Pinned tab

Permanent, non-closable. The user cannot close it. It sits at a fixed position in the tab bar, always visible while the plugin is active.

Use for domain-critical UI that should always be available. Example: the Azure DevOps Backlog, the GitHub Pull Requests list.

Two ways to ship a pinned tab:

**A. Claim a core DOM block.** First-party plugins (Azure DevOps, GitHub) extracted from the pre-plugin-first shell declare the DOM button + panel they own. The shell renders the existing UI; the plugin owns the behavior. This is the current state for Backlog, Work Item, Pull Requests, Activity, Team, and Git Log while their HTML and JS are progressively moved into plugin-owned files.

```json
{
  "id": "backlog",
  "label": "Backlog",
  "icon": "list-todo",
  "pinned": true,
  "position": 2,
  "claims": { "tabBtnId": "backlogTabBtn", "panelId": "panel-backlog" }
}
```

**B. Ship the HTML yourself.** A plugin bundles the tab HTML, rendered in an iframe inside the core column.

```json
{
  "id": "dashboard",
  "label": "Dashboard",
  "icon": "gauge",
  "pinned": true,
  "position": 5,
  "html": "tabs/dashboard.html"
}
```

**Position rules:**
- Core pinned tabs own `0` (Terminal) and `1` (Orchestrator).
- Plugin pinned tabs claim `2` and up.
- Ties break alphabetically by tab `id`. The alphabetically-smaller id takes the lower slot; the other shifts right by one.
- A plugin that omits `position` goes to the end of the pinned row.

### Popup tab

Hidden from the tab bar by default. Opened programmatically when a plugin or core action triggers it (clicking a row, opening a detail view, "Open Full Timeline", etc.). Closable by the user via an "x" on the tab.

Use for detail surfaces that are only meaningful in response to a user action. Example: the Azure DevOps Work Item editor (opens when the user clicks a backlog row), the full Activity Timeline (opens from the right-column intel panel).

```json
{
  "id": "workitem",
  "label": "Work Item",
  "icon": "ticket",
  "popup": true,
  "position": 3,
  "claims": { "tabBtnId": "workitemTabBtn", "panelId": "panel-workitem" }
}
```

The plugin owns both the open trigger (e.g. `viewWorkItem(id)` reveals the tab and renders into the claimed panel) and the close trigger (a button inside the panel calls `closePopupTab(tabBtnId)`). The shell only positions the tab at `position` when it is visible. There is no X on the tab itself; closing is the panel's job. `popup` and `pinned` are mutually exclusive.

### Ephemeral tab

Openable from the "+ Open Tab" menu, closable by the user. Appears only when the user opens it, disappears on close. Does not persist across restarts.

Use for tools the user reaches via the command palette or the + menu. Example: the WordPress post editor, the Builder.io canvas.

```json
{
  "id": "wp-editor",
  "label": "WordPress Editor",
  "icon": "wordpress",
  "html": "tabs/editor.html"
}
```

`pinned`/`popup` default to `false`. `position` is ignored. `html` is always an iframe.

### Right-column (intel) tabs

Same pinned vs ephemeral split, declared under `rightTabs` instead of `centerTabs`. `claims` takes `{tabBtnId, panelId}` that point at intel DOM (e.g. `intelTab-activity`, `ipanel-activity`).

---

## v1 (always available)

| Key            | Type    | Purpose                                                             |
|----------------|---------|---------------------------------------------------------------------|
| `settingsHtml` | string  | Path to an HTML file rendered inside the Plugins tab of Settings.   |
| `centerTabs`   | array   | `[{id,label,icon,html?,claims?,pinned?,position?}]` center-column tabs. |
| `routes`       | string  | Path to a `routes.js` file registering `/api/plugins/<id>/*` routes.|
| `mcp`          | object  | MCP tool definitions exposed via the DevOps Pilot MCP server.       |

## v2 (requires `sdkVersion: 2`)

| Key                 | Type    | Purpose                                                                                          |
|---------------------|---------|--------------------------------------------------------------------------------------------------|
| `rightTabs`         | array   | Same shape as `centerTabs`, rendered in the right intel column.                                  |
| `leftQuickActions`  | array   | `[{id,label,icon,command}]` buttons injected into the left rail below core actions.              |
| `repoSources`       | array   | `[{id,label,icon,cloneRoute,listRoute}]` repo provider shown in the repos modal.                 |
| `commitLinkers`     | array   | `[{id,pattern,urlTemplate}]` regex-driven auto-linkers for commit messages and branches.         |
| `workItemProvider`  | object  | `{listRoute,getRoute,updateRoute,createRoute,iterationsRoute,teamsRoute,activityRoute}` interface. |
| `prProvider`        | object  | `{listRoute,getRoute,createRoute,mergeRoute}` interface for the generic PR tab.                  |
| `aiActions`         | array   | `[{id,label,icon,prompt,intent}]` AI quick actions (standup, retro, etc).                        |
| `nativeSettings`    | object  | `{targetId, hideNavSelector?}` claim an existing settings DOM block at runtime.                  |
| `configKeys`        | `string[]` | Config keys owned by the plugin, persisted in `dashboard/plugins/<id>/config.json`.           |
| `sensitiveKeys`     | `string[]` | Config keys stripped from exports and preserved across imports (PATs, tokens).                |
| `imageAuth`         | array   | `[{hostnamePattern, authType, authConfigKey}]` URL-pattern auth injectors for `/api/image-proxy`. |

### Tab ordering: worked example

Core:
- position 0: Terminal
- position 1: Orchestrator

Active plugins:
- `azure-devops` contributes Backlog (`position: 2`), Work Item (`position: 3`), Activity (right, `position: 0`), Team (right, `position: 1`).
- `github` contributes Pull Requests (`position: 4`), Git Log (right, `position: 2`).
- `wordpress` contributes an ephemeral Editor tab (no position).

Center column left to right:
`Terminal -> Orchestrator -> Backlog -> Work Item -> Pull Requests -> [ephemeral tabs the user opened]`

Right column top to bottom:
`Activity -> Team -> Git Log -> Recipes (core, always last)`

If `github` also declared Backlog at `position: 2`, `azure-devops` (alphabetically earlier) keeps position 2 and `github`'s Backlog shifts to 3.

---

## `*Route` fields

- **Absolute** - any path that starts with `/api/`. Used verbatim.
- **Relative** - any other value. Resolved against the plugin prefix; both `"pulls"` and `"/pulls"` map to `/api/plugins/<id>/pulls`.

---

## Plugin endpoints

| Endpoint | Shape | Primary consumer |
|---|---|---|
| `GET /api/plugins` | active plugin manifests with full contributions | `initPlugins` in index.html |
| `GET /api/plugins/contributions` | aggregated per-type projection, each item tagged with `_origin` | `contributions-client.js` |

Both endpoints apply the same activation filter.

---

## Backward compatibility

- Plugins without `sdkVersion` default to v1.
- Unknown contribution keys log a warning.
- The old `legacyNativeTabs` / `legacyNativeRightTabs` keys are replaced by `pinned: true` (or `popup: true`) + `claims` on `centerTabs` / `rightTabs`. The shell accepts the old shape as an alias during upgrade: entries with `openable: true` (or no `openable` field) become `pinned: true`; entries with `openable: false` become `popup: true`. New plugins must use the new shape.
