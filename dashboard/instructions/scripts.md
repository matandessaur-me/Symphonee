# Pre-Made Scripts

Use these before writing anything custom. They handle the common DevOps Pilot operations.

**From bash**, prefix with: `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./scripts/<Name>.ps1"` (or `-Command` with args).

## Azure DevOps

| Script | Purpose |
|---|---|
| `Get-SprintStatus.ps1` | Current sprint overview |
| `Get-StandupSummary.ps1 -IterationPath '...'` | Standup summary of recent changes |
| `Get-Retrospective.ps1` | Last completed sprint analysis |
| `Get-WorkItem.ps1 -Id <id>` | Full work item detail |
| `New-WorkItem.ps1 -Type '...' -Title '...' -Priority <n> -StoryPoints <n>` | Create a work item |
| `Set-WorkItemState.ps1 -Id <id> -State <state>` | Change work item state |
| `Find-WorkItems.ps1 -Search '...' -Type '...' -State '...'` | Filter work items |
| `Get-MyWorkItems.ps1 [-State <state>]` | My assigned items grouped by state |
| `Run-Query.ps1 -File path/to/query.ps1` | Run a WIQL query from a ps1 file |
| `Refresh-Board.ps1` | Refresh board/backlog view |

## Git + GitHub (code lives on GitHub)

| Script | Purpose |
|---|---|
| `Show-Diff.ps1 -Repo '<name>'` | Open built-in diff viewer (NEVER use `git diff` in terminal) |
| `Commit-Changes.ps1 -Message '...'` | Stage + commit, auto-link `AB#<id>` |
| `Push-AndPR.ps1 -Repo '<name>'` | Push + create PR in one shot |
| `New-PullRequest.ps1 -Repo '<name>' -Title '...' -Description '...'` | PR with custom body |

## Graph Runs (BETA — see graph-runs.md)

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

## Notes (from bash)

`node scripts/save-note.js "Title" "body"` or `node scripts/save-note.js "Title" --file .ai-workspace/note.md`. NEVER `Save-Note.ps1` from bash — it chokes on special chars.
