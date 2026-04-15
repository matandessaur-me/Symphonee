## Available API Endpoints

This reference covers ONLY the core shell. Every provider integration -- issue tracking, code hosting, CMS, analytics -- lives in a plugin and exposes its own routes under `/api/plugins/<id>/*`. To discover those, fetch `/api/plugins/instructions` (all active plugins) or `/api/plugins/<id>/instructions` (one plugin) after the user agrees to use that plugin.

### Config & Repos
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/config` | Current configuration |
| POST | `/api/config` | Save config changes. Body: key-value pairs to update |
| GET | `/api/config/export` | Export settings to JSON (PATs stripped) |
| POST | `/api/config/import` | Import settings + auto-install missing plugins |
| POST | `/api/config/reset` | Factory reset. Body: `{ confirm: true }` -- wipes config, plugin configs, notes, recipes, learnings, display prefs |
| GET | `/api/repos` | Configured local repositories |
| GET | `/api/prerequisites` | Check which AI CLIs are installed |
| POST | `/api/cli/install` | Install a Node CLI globally. Body: `{ name }` |

### File Operations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/files/tree?repo={name}` | Browse directory tree (respects .gitignore) |
| GET | `/api/files/read?repo={name}&path={file}` | Read file contents (with syntax highlight language detection) |
| POST | `/api/files/save` | Save file (atomic write). Body: `{ repo, path, content }` |
| GET | `/api/files/search?repo={name}&query={text}` | Full-text search across files (regex, glob patterns) |
| GET | `/api/files/grep?repo={name}&pattern={regex}` | Search file contents with ripgrep |
| GET | `/api/files/serve?repo={name}&path={file}` | Serve binary files (images, etc.) with caching |

### Git Actions
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/git/status?repo={name}` | Current branch and changed files |
| GET | `/api/git/branches?repo={name}` | List local branches |
| GET | `/api/git/log?repo={name}&count={20}` | Recent commits |
| GET | `/api/git/diff?repo={name}&path={file}` | Unified diff output |
| POST | `/api/git/fetch` | Fetch + prune remote, returns local and remote-only branches. Body: `{ repo }` |
| POST | `/api/git/checkout` | Switch branch (fails if dirty). Body: `{ repo, branch }` |
| POST | `/api/git/pull` | Pull latest from remote. Body: `{ repo }` |
| POST | `/api/git/push` | Push current branch to remote. Body: `{ repo }` |
| GET | `/api/git/split-diff?repo={name}` | Get diff in split (2-column) format |
| GET | `/api/git/commit-diff?repo={name}&hash={sha}` | Get diff for a specific commit |
| POST | `/api/git/discard` | Discard local changes. Body: `{ repo }` **DANGEROUS** |

**Note:** Branch switching, pull, and push are handled by the dashboard's Git modal (not the AI terminal). The AI is only involved for **Commit Changes** (when "Let AI Decide" is chosen) and **Compare Branches** (AI analyzes the diff).

### Notes (markdown scratchpad -- you can read and write notes)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notes` | List all notes |
| GET | `/api/notes/read?name={name}` | Read a note's content |
| POST | `/api/notes/save` | Save a note. Body: `{ name, content }` |
| POST | `/api/notes/create` | Create a new note. Body: `{ name }` |
| DELETE | `/api/notes/delete` | Delete a note. Body: `{ name }` |
| GET | `/api/notes/export?name={name}` | Download a single note as markdown |
| GET | `/api/notes/export-all` | Download all notes as a JSON bundle |
| POST | `/api/notes/import` | Import notes. Body: `{ notes: { name: content } }` |

When asked to gather information or create summaries, you can save them as notes using the API. The user can then review, edit, and send them back to you.

### UI Control (navigate the dashboard contextually)

You can control the dashboard UI. **Use these intelligently based on context** -- don't auto-navigate after every action. Instead, offer to navigate when it makes sense.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/ui/tab` | Switch tab. Body: `{ tab: "terminal"\|"files"\|"notes"\|<plugin-tab-id> }` |
| POST | `/api/ui/view-note` | Open a note in preview. Body: `{ name: "My Note" }` |
| POST | `/api/ui/view-file` | Open a file in the code viewer. Body: `{ repo: "RepoName", path: "src/index.ts", line: 132 }` (line is optional -- scrolls to and highlights that line) |
| POST | `/api/ui/view-diff` | Open split diff for a file. Body: `{ repo: "RepoName", path: "src/index.ts", base: "HEAD" }` |
| POST | `/api/ui/view-commit-diff` | Open the commit diff viewer for a specific commit. Body: `{ repo: "RepoName", hash: "abc1234" }` (`commit` is also accepted as an alias for `hash`) |
| POST | `/api/ui/view-plugin` | Open a plugin tab. Body: `{ plugin: "pluginId", message: { type: "action", ... } }` (message is optional -- forwarded to the plugin iframe via postMessage) |
| GET | `/api/ui/context` | Get current dashboard state: active repo, activeRepoPath, and any context keys plugins have registered (iteration, area, etc.) |
| POST | `/api/ui/context` | Update UI context. Body: key-value pairs |

Plugins can register additional UI-view endpoints (open a work item, open a pull request, open the plugin's own tab). See each plugin's `instructions.md` for the routes it contributes; they are all namespaced under `/api/ui/view-*` or `/api/plugins/<id>/*`.

**Command Palette:** The user can press `Ctrl+K` or click the search bar at the top to open the Command Palette. It provides quick access to all actions, tabs, repos, and (when relevant plugins are installed) work items. The AI does NOT need to use this -- it's a UI shortcut for the user.

**How to navigate (from bash -- use curl):**
```bash
curl -s -X POST http://127.0.0.1:3800/api/ui/tab -H "Content-Type: application/json" -d '{"tab":"notes"}'
curl -s -X POST http://127.0.0.1:3800/api/ui/view-note -H "Content-Type: application/json" -d '{"name":"My Note"}'
```

**From PowerShell PTY:** Use `Invoke-RestMethod` with the same endpoints and JSON bodies as above.

### Orchestrator API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orchestrator/agents` | List all active terminals (enrich with AI state from frontend) |
| POST | `/api/orchestrator/inject` | Inject text into a terminal's PTY. Body: `{ termId, text }` |
| POST | `/api/orchestrator/dispatch` | Dispatch a task to a running AI terminal. Body: `{ targetTermId, prompt, from?, timeout? }` |
| POST | `/api/orchestrator/spawn` | Spawn an AI CLI for a one-shot task. Body: `{ cli, prompt, cwd?, timeout?, from?, visible? }` (cli: claude/gemini/codex/copilot/grok; defaults to headless pipe mode) |
| GET | `/api/orchestrator/tasks` | List tasks. Query: `?state=running&from=main&cli=claude&limit=50` |
| GET | `/api/orchestrator/task?id={id}` | Get a specific task's status and result |
| POST | `/api/orchestrator/cancel` | Cancel a running task. Body: `{ taskId }` |
| POST | `/api/orchestrator/message` | Send a message to a terminal's inbox. Body: `{ to, from?, content, metadata? }` |
| POST | `/api/orchestrator/broadcast` | Broadcast a message to all terminals. Body: `{ from?, content, metadata? }` |
| GET | `/api/orchestrator/inbox?termId={id}` | Read a terminal's inbox. Add `&unread=1` for unread only |
| POST | `/api/orchestrator/inbox/clear` | Clear a terminal's inbox. Body: `{ termId }` |
| POST | `/api/orchestrator/cleanup` | Clean up old completed tasks. Body: `{ maxAgeMs? }` |
| POST | `/api/orchestrator/handoff` | **Blocking** handoff: spawn, wait for result, return it. Body: `{ cli, prompt, cwd?, from?, handoffTimeout? }` |
| POST | `/api/orchestrator/spawn-with-deps` | Spawn a task that waits for dependencies. Body: `{ cli, prompt, from?, dependsOn: ["taskId1", "taskId2"] }` |
| POST | `/api/orchestrator/spawn-worktree` | Spawn in isolated git worktree. Body: `{ cli, prompt, repoPath, branch?, from? }` |
| POST | `/api/orchestrator/cleanup-worktree` | Remove a task's worktree after merging. Body: `{ taskId }` |
| GET | `/api/orchestrator/heartbeats` | Health check: active/idle/stale status for all running tasks |
| GET | `/api/orchestrator/circuit-breaker` | Circuit breaker status per CLI (closed/open/half-open) |
| POST | `/api/orchestrator/circuit-breaker/reset` | Reset a CLI circuit breaker. Body: `{ cli }` |
| GET | `/api/orchestrator/checkpoints` | Saved checkpoints from failed/timed-out tasks |
| POST | `/api/orchestrator/spawn-escalate` | Spawn with auto-escalation (cheapest CLI first, escalates on failure). Body: `{ prompt, preferCli?, cwd?, from? }` |
| POST | `/api/orchestrator/fan-out` | Spawn multiple tasks in parallel with staggered starts. Body: `{ tasks: [{cli, prompt, from?}...], maxConcurrent?, staggerMs?, aggregate? }` |
| POST | `/api/orchestrator/spawn-lineage` | Spawn with sibling/parent awareness. Body: `{ cli, prompt, from?, parentTaskId?, siblingTaskIds? }` |
| POST | `/api/orchestrator/pause` | Pause orchestration (hold queued tasks) |
| POST | `/api/orchestrator/resume` | Resume orchestration |
| POST | `/api/orchestrator/wait-for` | Block until a task completes. Body: `{ taskId, timeoutMs? }` |
| GET | `/api/orchestrator/aggregate?taskIds=id1,id2` | Quality-ranked aggregation of multiple task results |

### Orchestrator Permission Notes

- **Reading orchestrator data** (GET endpoints) does NOT require user permission
- **Injecting into terminals, dispatching tasks, spawning headless processes** actively control other terminals. Use them when the user asks you to coordinate with other AIs. Do NOT silently dispatch tasks without the user's knowledge.
- The orchestrator UI tab shows all active agents and tasks. The user can monitor everything.

### Learnings Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/learnings` | List all learnings (filter by ?category= or ?cli=) |
| GET | `/api/learnings/markdown` | Get learnings as markdown |
| POST | `/api/learnings` | Add a learning. Body: `{ category, cli?, summary, detail?, source? }` |
| DELETE | `/api/learnings` | Delete a learning. Body: `{ id }` |
| POST | `/api/learnings/sync` | Pull shared learnings + push unsynced ones |

### Browser Automation Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/browser/launch` | Launch browser. Body: `{ headless, session }` |
| POST | `/api/browser/navigate` | Go to URL. Body: `{ url }` |
| POST | `/api/browser/fill` | Fill form field. Body: `{ selector, value }` |
| POST | `/api/browser/click` | Click element. Body: `{ selector }` |
| POST | `/api/browser/type` | Type text into element. Body: `{ selector, text }` |
| POST | `/api/browser/press-key` | Press keyboard key. Body: `{ key }` |
| POST | `/api/browser/wait-for` | Wait for selector. Body: `{ selector, timeout }` |
| GET | `/api/browser/screenshot` | Take screenshot (returns base64 PNG) |
| GET | `/api/browser/read-page` | Extract text content. Query: `?selector=` (optional) |
| GET | `/api/browser/query-all` | List elements matching selector. Query: `?selector=` |
| GET | `/api/browser/cookies` | Get current cookies |
| GET | `/api/browser/sessions` | List saved sessions |
| GET | `/api/browser/accounts` | List your saved accounts (name, email) |
| POST | `/api/browser/save-session` | Save cookies to disk. Body: `{ name }` |
| POST | `/api/browser/close` | Close browser (auto-saves session) |
| POST | `/api/browser/check-email` | Check webmail for verification. Body: `{ provider, email, password, subjectPattern }` |

### Browser Account Access

You have dedicated accounts the user configured for your use. **NEVER say you do not have accounts. Always check first.**

```bash
curl -s http://127.0.0.1:3800/api/browser/accounts   # List saved accounts (name, email)
curl -s http://127.0.0.1:3800/api/config               # Full credentials in BrowserCredentials field
```

### Browser Permission Rules
- **You MUST ask the user before launching a browser session**
- **You MUST ask before filling in credentials or submitting forms**
- **You MUST ask before clicking buttons that perform external actions** (sign up, purchase, send message, etc.)
- You may read pages, take screenshots, and query elements without asking
- All browser POST endpoints are blocked when Incognito Mode is active

### Browser Workflow
Launch browser with a session name, navigate to the target page, use `query-all` to understand the form structure, then fill fields and click submit. Save the session for reuse, and close when done. The typical flow is: `launch` -> `navigate` -> `query-all` -> `fill`/`click` -> `save-session` -> `close`.

### Voice & Media
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/voice/transcribe` | Transcribe audio to text (OpenAI Whisper). Requires WhisperKey in config |
| GET | `/api/image-proxy?url={url}` | Generic image proxy with auth headers |

### System & Utilities
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server health check |
| GET | `/api/busy` | Show which async operations are in-flight |
| POST | `/api/open-external` | Open URL in system browser. Body: `{ url }` |
| GET | `/api/project/scripts?repo={name}` | Get scripts defined in package.json |
| GET | `/api/themes` | Read custom themes |
| POST | `/api/themes` | Save custom themes |

### Plugin Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/plugins` | List active plugins and their scripts |
| GET | `/api/plugins/instructions` | Concatenated markdown instructions from all active plugins |
| GET | `/api/plugins/contributions` | Aggregated contributions (tabs, providers, linkers, actions) across active plugins |
| GET | `/api/plugins/registry` | Fetch available plugins from GitHub registry |
| POST | `/api/plugins/install` | Install plugin from local path. Body: `{ path }` |
| POST | `/api/plugins/install-from-registry` | Clone plugin from registry. Body: `{ id }` |
| POST | `/api/plugins/update` | Update installed plugin. Body: `{ id }` |
| POST | `/api/plugins/uninstall` | Uninstall plugin. Body: `{ id }` |
