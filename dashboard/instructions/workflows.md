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

### Work Item Creation

When creating work items, ALWAYS include:
1. **Title**: clear, concise, descriptive (plain text only, no special characters)
2. **Description**: detailed enough to understand the full scope. Include context, what needs to happen, and why.
3. **Story Points**: always estimate (1, 2, 3, 5, 8, 13). Use your best judgment based on complexity.
4. **Priority**: default to 2 (Normal) unless specified
5. **Acceptance Criteria**: add when the work item is non-trivial (features, user stories). Skip for small bugs or simple tasks.
6. **Iteration**: use `selectedIteration` from `/api/ui/context`. If null ("All Iterations"), leave `iterationPath` empty. NEVER assume the current sprint.

### Changing Work Item State

When moving a work item to **Active** or **Resolved**:
1. First, fetch the team members from `/api/team-members`
2. Look up the `DefaultUser` from `/api/config`
3. If the user is found in the team members list, assign the work item to them
4. If not found, leave it unassigned

State transitions:
- **New -> Active**: Assign to the user, work is starting
- **Active -> Resolved**: Assign to the user, work is complete and ready for review
- **Resolved -> Closed**: Work has been verified

### Workflow Guidelines

1. **When asked about iteration status**: Fetch iterations, find current iteration, get work items and burndown data, summarize progress.
2. **When asked to create work items**: Follow the creation guidelines above. Always include story points and a descriptive description.
3. **When doing standup summaries**: Fetch current iteration items, group by state, highlight recently changed items.
4. **When starting work on an item**: Use the `/api/start-working` endpoint which creates a git branch and sets the item to **Active**. If you created the work item yourself and then start working on it, make sure its state moves to Active.
5. **When asked "where are we at?"**: Combine iteration burndown, item states, and velocity to give a comprehensive status.

### Git Branch Workflow

When starting work on a task, the system automatically:
1. Checks out `main` (or `master`)
2. Fetches from origin
3. Pulls latest changes
4. Creates a **local** branch: `feature/AB#12345-task-title` or `bugfix/AB#12345-bug-title`

**The `AB#` prefix links the branch to the Azure DevOps work item.**

**Branches are LOCAL until the user explicitly pushes.** Do NOT push the branch to origin when creating it. The user will push when they are ready (after committing and reviewing their work). Only push when the user asks to push, or when creating a pull request.

**NEVER work on an existing branch unless the user explicitly asks.** Always create a fresh branch from main.

### Before Committing

**ALWAYS follow this sequence before committing:**

1. Show the user what changed FIRST by opening the diff viewer:
   - **Bash:** `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./scripts/Show-Diff.ps1"`
   - **PowerShell PTY:** `.\scripts\Show-Diff.ps1`

2. **Wait for the user to review the changes.**

3. Only THEN ask: "Ready to commit these changes?"

4. **Never skip straight to committing.** The user must see the diff first.

5. When committing, include `AB#WorkItemId` in the commit message to link it to ADO:
   ```
   git commit -m "Fix login timeout issue AB#12345"
   ```

6. **After committing**, ask the user: "Want me to move AB#12345 to **Resolved**?"
   - Only move to Resolved if the user confirms.
   - Do NOT auto-resolve without asking.

### Work Item Lifecycle During Development

Follow this sequence when working on a task tied to a work item:

1. **Start working** -> **AUTOMATICALLY** move the work item to **Active** (via `/api/start-working`, or manually via the API). Do NOT wait for the user to ask.
2. **Write code** -> Work item stays Active
3. **Show diff** -> Let the user review changes
4. **Commit** -> Ask "Ready to commit?"
5. **After commit** -> **AUTOMATICALLY** move the work item to **Resolved** (ask the user for confirmation first: "Want me to move AB#12345 to Resolved?"). Do NOT forget this step.
6. **Push / Create PR** -> Only when the user asks

**The AI MUST manage work item states proactively.** When a work item is being worked on, its state should be Active. When work is committed, ask to Resolve it. NEVER leave a work item in "New" while actively coding on it. NEVER forget to offer to Resolve after committing. These state transitions are a core part of the workflow, not optional.

### Creating Pull Requests

**Use the built-in script to create PRs on GitHub (NEVER use `gh` CLI, see Absolute Rules):**

```bash
# From bash: push + create GitHub PR in one shot (auto-detects branch, generates title, links AB# work item)
powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Push-AndPR.ps1 -Repo 'MyRepo'"

# With a custom title and target branch
powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Push-AndPR.ps1 -Repo 'MyRepo' -Title 'Add feature X' -Description 'Details here' -TargetBranch 'develop'"
```

You can also use `New-PullRequest.ps1` directly if you need more control over the PR title and description.
