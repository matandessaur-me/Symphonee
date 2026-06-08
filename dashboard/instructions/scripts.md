# Pre-Made Scripts

Use these before writing anything custom. They handle the common Symphonee operations.

**From bash**, prefix with: `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./scripts/<Name>.ps1"` (or `-Command` with args). Plugin scripts live under `./dashboard/plugins/<plugin-id>/scripts/<Name>.ps1`.

## Core (ship with the app)

| Script | Purpose |
|---|---|
| `Show-Diff.ps1 -Repo '<name>'` | Open built-in diff viewer (NEVER use `git diff` in terminal) |
| `Commit-Changes.ps1 -Message '...'` | Stage + commit |
| `Save-Note.ps1` / `save-note.js` | Save a note (use `node scripts/save-note.js` from bash) |
| `Search-Notes.ps1 -Query '...'` | Hybrid search across notes + learnings |
| `Get-RepoMap.ps1` | Generate symbol map for the active repo |
| `Create-Shortcut.ps1` | Create a desktop shortcut to Symphonee |
| `Run-Query.ps1 -File path/to/query.ps1` | Run a generic query script |
| `Get-PluginInstructions.ps1 [-Plugin <id>]` | Fetch AI instructions from installed plugins |

## Renderer build (when editing the dashboard UI)

The served `dashboard/public/js/app.js` and `mind-ui.js` are GENERATED. Edit the
source (`dashboard/public/app/src/shell/*.js` or `mind-ui/src/*.js`) and rebuild --
never hand-edit the output. See the `verify-frontend-edit` skill.

| Command | Purpose |
|---|---|
| `npm run build:renderer` (`node scripts/build-renderer.js`) | Rebuild `app.js` (concat parts) + `mind-ui.js` (esbuild bundle) |
| `npm run watch:renderer` (`... --watch`) | Rebuild on source change during dev |

## Mind (shared knowledge graph)

| Script | Purpose |
|---|---|
| `Build-Mind.ps1` / `node scripts/build-mind.js` | Full rebuild of the brain (POST `/api/mind/build`) |
| `Query-Mind.ps1 -Question '...'` / `query-mind.js` | Code-graph BFS (POST `/api/mind/query`) |
| `Show-Mind.ps1 [-NodeId <id>]` | Visualise the graph or one node |
| `Add-To-Mind.ps1 -Url <u> -Label '...' -Kind doc` | Add one artefact (POST `/api/mind/add`) |

## Instruction Coherence

| Script | Purpose |
|---|---|
| `Audit-Instructions.ps1` | Re-run the 4 coherence checks (URLs / triggers / atoms / file sizes) |
| `Audit-Instructions.ps1 -UpdateBaseline` | Regenerate `scripts/audit-baseline.txt` after an intentional atom removal |

## Apps Automation

| Script | Purpose |
|---|---|
| `Invoke-AppsDo.ps1 -App <name> -Goal '...'` | Wrap `POST /api/apps/do` (default entry point for "open X and do Y") |

## Graph Runs (see graph-runs.md)

| Script | Purpose |
|---|---|
| `Start-GraphRun.ps1 -File <json>` | Start a run |
| `Get-GraphRun.ps1 [-Id <id>]` | List or detail |
| `Approve-GraphNode.ps1 -RunId <id> -NodeId <node>` | Approve a gate |
| `Stop-GraphRun.ps1 -Id <id> -Action pause\|resume\|cancel` | Lifecycle |

## Model Router

| Script | Purpose |
|---|---|
| `Get-ModelRecommendation.ps1 -Intent <intent> [-Budget cheap\|default\|premium]` | Pick CLI + model for a task |

## Plugin scripts

Installed plugins ship their own scripts under `./dashboard/plugins/<id>/scripts/`. Call them via the same PowerShell prefix but substitute the plugin path. The plugin's `instructions.md` (fetchable via `./scripts/Get-PluginInstructions.ps1 -Plugin <id>`) documents each one. NEVER assume a plugin is installed; check `/api/plugins` or the bootstrap payload first.

## Notes (from bash)

`node scripts/save-note.js "Title" "body"` or `node scripts/save-note.js "Title" --file .ai-workspace/note.md`. NEVER `Save-Note.ps1` from bash -- it chokes on special chars.
