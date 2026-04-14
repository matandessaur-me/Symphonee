# Shell, Path, and Speed Rules

## You may be in either shell

**Bash** (Claude Code, Git Bash, MSYS2):
- ALWAYS use `powershell.exe -ExecutionPolicy Bypass -NoProfile -File` to run `.ps1` scripts
- ALWAYS use forward slashes in paths (bash treats backslashes as escapes)
- NEVER use `.\scripts\...`, use `./scripts/...`
- Example: `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "./scripts/Get-SprintStatus.ps1"`
- With args: `powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "./scripts/Get-WorkItem.ps1 -Id 12345"`

**PowerShell PTY** (the app's built-in terminal):
- Run scripts directly: `.\scripts\Get-SprintStatus.ps1`
- Backslashes are fine.

**How to tell:** bash prompt is `$`, paths use `/`, tool is called "Bash". PowerShell PTY prompt is `PS>`.

## Universal rules

1. ALWAYS use pre-made scripts in `scripts/`.
2. Temp files go in `.ai-workspace/`. Clean up when done.
3. NEVER use `Invoke-RestMethod` inline with `$_` from bash — bash eats `$_`. Put complex queries in a `.ps1` file first.
4. All scripts run with `-ExecutionPolicy Bypass -NoProfile` already set.
5. NEVER use `node -e` with piped input or inline code. On Windows `/dev/stdin` resolves to `C:\dev\stdin` which doesn't exist. Write to a temp file, then run a small `.js` file.
6. NEVER use `/tmp/` paths — doesn't exist on Windows. Use `$TEMP` or `.ai-workspace/`.
7. `pwsh` / `pwsh.exe` is NOT installed. Use `powershell.exe`.

## Speed rules

1. **Save a note from bash**: `node scripts/save-note.js "Title" "content"`. Long content: write to `.ai-workspace/my-note.md` first, then `--file .ai-workspace/my-note.md`. NEVER use PowerShell's `Save-Note.ps1` from bash — it chokes on special chars.
2. Create / query work items: run the script directly. No wrappers.
3. NEVER create a script just to call another script.
4. NEVER create intermediate test scripts.

## Punctuation

**ASCII only, correct punctuation, everywhere.** No emojis, no em dashes, no en dashes, no double-dashes, no smart quotes, no ellipsis characters (use `...`), no non-breaking spaces. Applies to PR bodies, commit messages, code comments, titles, descriptions.
