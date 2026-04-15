## Workflow Rules

### Showing Changes to the User

**When the user asks to see changes, review changes, or show a diff, ALWAYS use the diff viewer, NOT terminal output.**

**ALWAYS pass the `-Repo` parameter** with the configured repo name (from `/api/ui/context` -> `activeRepo`). If you omit it, the diff viewer may open with no repo selected and show nothing.

```bash
# From bash: show all working changes in the diff viewer (ALWAYS include -Repo)
powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Show-Diff.ps1 -Repo 'My Website'"

# Show a specific file in the diff viewer
powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Show-Diff.ps1 -Repo 'My Website' -Path 'src/components/Header.tsx'"
```

**NEVER use `git diff` in the terminal to show changes.** The dashboard has a built-in diff viewer with syntax highlighting and side-by-side comparison. Use it.
**NEVER omit the `-Repo` parameter.** Always check `/api/ui/context` for `activeRepo` and pass it.

### Git Branch Workflow

When starting work on a task:
1. Check out `main` (or `master`)
2. Fetch from origin (if a remote is configured)
3. Pull latest changes (if a remote is configured)
4. Create a **local** branch with a descriptive name (`feature/<slug>` or `bugfix/<slug>`)

**Branches are LOCAL until the user explicitly pushes.** Do NOT push the branch to origin when creating it. The user will push when they are ready (after committing and reviewing their work). Only push when the user asks to push, or when creating a pull request.

**NEVER work on an existing branch unless the user explicitly asks.** Always create a fresh branch from main.

Plugins can extend this workflow -- work-item linking, PR auto-creation, branch naming conventions, state transitions. If any plugin matches the user's task, fetch its `instructions.md` via `/api/plugins/instructions` (or `/api/plugins/<id>/instructions`) and follow its rules on top of this baseline.

### Before Committing

**ALWAYS follow this sequence before committing:**

1. Show the user what changed FIRST by opening the diff viewer:
   - **Bash:** `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./scripts/Show-Diff.ps1"`
   - **PowerShell PTY:** `.\scripts\Show-Diff.ps1`
2. **Wait for the user to review the changes.**
3. Only THEN ask: "Ready to commit these changes?"
4. **Never skip straight to committing.** The user must see the diff first.

### Plugin-driven workflows

Work-item tracking, commit-message auto-linking, pull-request creation, and state transitions are all plugin-owned. If the relevant plugin is installed, follow the rules in that plugin's `instructions.md` (fetchable via `./scripts/Get-PluginInstructions.ps1 -Plugin <id>` or from `/api/plugins/instructions`). If the plugin is NOT installed, do not invent those rules -- complete the task with plain git and tell the user which plugin would automate the rest.
