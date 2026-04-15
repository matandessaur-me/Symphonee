# Pre-Made Scripts

Use these before writing anything custom. They handle the common Symphonee operations.

**From bash**, prefix with: `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./scripts/<Name>.ps1"` (or `-Command` with args). Plugin scripts live under `./dashboard/plugins/<plugin-id>/scripts/<Name>.ps1`.

## Core (ship with the app)

| Script | Purpose |
|---|---|
| `Show-Diff.ps1 -Repo '<name>'` | Open built-in diff viewer (NEVER use `git diff` in terminal) |
| `Commit-Changes.ps1 -Message '...'` | Stage + commit |
| `Get-Recipes.ps1` | List installed recipes |
| `Run-Recipe.ps1 -Id <id>` | Execute a recipe |
| `Save-Note.ps1` / `save-note.js` | Save a note (use `node scripts/save-note.js` from bash) |
| `Search-Notes.ps1 -Query '...'` | Hybrid search across notes + learnings |
| `Get-RepoMap.ps1` | Generate symbol map for the active repo |
| `Create-Shortcut.ps1` | Create a desktop shortcut to Symphonee |
| `Run-Query.ps1 -File path/to/query.ps1` | Run a generic query script |
| `Get-PluginInstructions.ps1 [-Plugin <id>]` | Fetch AI instructions from installed plugins |

## Graph Runs (BETA -- see graph-runs.md)

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
