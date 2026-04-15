# CHANGELOG

All notable changes to DevOps Pilot. Most recent first.

## 2026-04-14 to 2026-04-15

This window covers the plugin-first-shell cutover plus a set of independent
additions that landed alongside it: hybrid search, the recipes subsystem,
MCP integration, runtime permission modes, and the model router.

### Plugin-First Shell (headline change)

The dashboard is no longer an Azure-DevOps / GitHub app with a few bolt-on
integrations. It is now a shell that ships with terminal, notes, files,
diffs, git, repo management, recipes, and the orchestrator. Every provider
integration lives in its own plugin folder, installs from a GitHub registry,
and contributes tabs / sidebar actions / PR and work-item providers / repo
sources / commit linkers / AI actions / MCP tools through a single manifest.

- **Plugin SDK v2** with a browser-side `contributions-client.js` exposing
  `providerFetch`, plugin tab registry, and postMessage helpers.
- **Plugin loader** gained `install-from-registry`, `update` (preserves
  config), and `uninstall` with a `keepConfig` flag. Uninstalls drop a
  tombstone into `config/uninstalled-plugins.json` so the legacy migration
  cannot silently re-clone a plugin the user just removed. Preserved configs
  live in `config/plugin-configs-preserved/<id>.json` and are restored on
  reinstall.
- **Azure DevOps and GitHub fully extracted** into their own plugin repos.
  All `workitems/`, `iterations`, `teams`, `areas`, `velocity`, `burndown`,
  `start-working`, `github/*`, and `pull-request` routes, plus 11
  PowerShell helper scripts, left the core.
- **Core instructions are plugin-agnostic.** `INSTRUCTIONS.base.md` and
  `dashboard/instructions/*.md` no longer mention any provider by name.
  Plugin-specific rules (work-item linking, PR creation, etc.) live in each
  plugin's own `instructions.md` and are fetched via
  `/api/plugins/instructions` on demand. ADO and GitHub are now treated
  identically to Builder.io, Sanity, WordPress, and the rest.
- **Bootstrap contract**. Every CLI (Claude Code, Codex, Gemini, Copilot,
  Grok) executes a 7-phase bootstrap from a single `/api/bootstrap` call
  that returns context + instructions + plugin keyword index + learnings +
  permissions, with a checksum the CLI echoes in its first reply.
- **Plugin-aware 404**. Hitting a former-core route returns a structured
  `{ pluginRequired }` response pointing the user at the plugin that owns
  the URL.
- **Per-plugin activation gating**. Sidebar actions, tabs, command palette
  entries, and AI instruction sections are all driven by plugin
  contributions + activation conditions; nothing provider-specific is
  hard-coded in the shell.
- **Settings plugin panel**. Each plugin renders its own settings section
  under a single Plugins tab. The app auto-restarts when saving settings
  flips a plugin's activation state.
- **Onboarding** is plugin-first with a skippable "Install Plugins" step
  and a skip-to-terminal option.
- **Upgrade migration** auto-installs ADO / GitHub plugins from the
  registry when legacy PAT config is detected (and the user has not
  explicitly uninstalled them).
- **Export / import** covers config, plugin configs, notes, recipes,
  learnings, and display preferences in one bundle, and auto-installs any
  missing plugins on import.
- **Factory reset** wipes config, plugin configs, notes, recipes,
  learnings, and display preferences after an Export-first confirmation.

Details and a before/after comparison in
`docs/CHANGELOG-plugin-first-shell.md`.

### Recipes: reusable AI workflows as markdown (#18)

- A recipe is a single markdown file with YAML frontmatter describing
  which CLI / model / intent to use, which plugins and MCP servers to
  expose, what permission mode to enforce, typed inputs, and a prompt
  template body with `{{ inputs.X }}` / `{{ context.X }}` substitution.
- Full CRUD from the UI: in-app recipe builder, Monaco editor for the
  body, labeled variable picker, icon picker, preview with server-side
  default-template rendering, Run flow that prompts for inputs.
- Smart input selectors (repo dropdown from `/api/repos`, plugin-provided
  pickers) and an always-visible "Will run with" context panel.
- Recipes tab lives in the right intel column; shipped defaults are
  shell-only (find-todos, smoke-test-shell, what-changed-recently).
  User-authored recipes are stored in `~/.devops-pilot/recipes/`; the
  "Folder" button opens the user scope (shipped recipes can't be deleted
  from the UI).
- Inject-mode runs gate on the active terminal having an AI launched.

### Hybrid Search + Repo Map (#19)

- New cross-corpus search over notes, recipes, learnings, and repo files
  with combined lexical + vector scoring. Promoted out of BETA to
  always-on after stabilization.
- Command palette integration: slash-prefix optional, keyword pill,
  match counts, jump-to-match. Clickable learning viewer inside the
  palette.
- In-note `Ctrl+F` with overlay highlights that survive focus changes.
- Repo Map: Monaco-backed viewer with Code / Preview toggle and a
  sidebar AI action shortcut.

### MCP integration (#13)

- DevOps Pilot itself is now exposed as a Model Context Protocol server
  over stdio.
- MCP client manager + per-plugin MCP reflection + Settings UI for
  configuring external MCP servers.

### Runtime permission modes (#12)

- Four header-chip modes: `review`, `edit` (default), `trusted`,
  `bypass`. Rule engine with allow / ask / deny buckets and a dedicated
  approval modal.
- Mode drives child-worker YOLO flags; the old YoloCliList is retired
  and the mode is the single source of truth.

### Model router

- Subscription-aware CLI / model picker. Call
  `Get-ModelRecommendation.ps1 -Intent <intent>` and feed the returned
  `cli` + `model` into `/api/orchestrator/spawn` or a graph-run worker
  node instead of hard-coding a CLI.

### Graph Runs (BETA) + Orchestrator polish

- Durable multi-step workflows with branching, approval gates, and
  multi-hour survival. Runs resume from `awaiting-approval` on engine
  boot; branch-merge skips only unreachable descendants; approvals
  surface in the header approval modal.
- Graph Runs fold into the AI Orchestration BETA toggle (one switch
  controls both); result-delivery dropdown dropped.
- Orchestrator UI auto-scrolls live outputs and force-submits injected
  results so lines do not sit in the terminal buffer.
- Graph-run completion injects a line into the originating terminal.

### CLAUDE.md / AGENTS.md trim

- Detail moved to fetchable `/api/instructions/*` endpoints. Learnings
  are no longer inlined (they are fetched at bootstrap), which kept
  CLAUDE.md well under the 40 KB warning threshold and stopped it from
  growing with every new learning entry.

### Smaller polish and fixes

- Iteration selector defaults to "All Iterations" instead of the current
  sprint.
- Right-column intel tab defaults to the visible tab with the lowest CSS
  `order` (so Git Log appears first when ADO is not present, instead of
  jumping to Recipes).
- Openable plugin tabs slot after the core pinned tabs
  (Terminal / Files / Diff / Notes) via `order = 1001+`, so plugin tabs
  no longer land between Terminal and Notes.
- Settings chip at the bottom left always reads "Settings" instead of
  "Not configured" or the ADO project name.
- Monaco editor picks `vs` or `vs-dark` based on `--base` luminance, so
  light themes no longer show light text on light backgrounds.
- Sidebar repo list renders independently of any provider plugin.
- Left-column Git actions hidden until at least one repo is configured.
- Factory-reset modal sits at `z-index: 300` so it stays above the
  settings modal.
- Shell rules: `curl -s` on PowerShell is an alias for `Invoke-WebRequest`
  and hangs on the `-s` flag -- use `curl.exe` or `Invoke-RestMethod`.
- `save-note.js` accepts the named-flag form (`--title`, `--body`,
  `--file`) for bash orchestration, alongside positional args.
