<img src="https://repository-images.githubusercontent.com/1187508410/facc0c4e-1126-42b7-81c6-eabbb7b5da07" alt="symphonee-logo"/>

# Symphonee

**Execution Engine for AI Workflows**

**Run your work like a system.** Symphonee is a local-first execution engine that conducts multiple AI CLIs and plugins as one unified workflow. No switching. No copy-paste. Your whole stack, in concert.

*DOit once. REpeat less. MIss nothing.*

> Created and maintained by **[Matan Dessaur](https://github.com/M8N-MatanDessaur)**

---

## The Orchestra

Symphonee treats your tools the way a symphony treats its sections.

- **The Conductor** is you, issuing intent.
- **The Score** is the graph run, recipes, and notes that describe what must happen.
- **The Orchestrator** is the bus that routes work across agents and keeps time.
- **The Instruments** are the plugins: Azure DevOps, GitHub, Sanity, Builder.io, WordPress, and anything else you install per project.
- **The Players** are the CLIs: Claude Code, Codex, Gemini CLI, Grok, Qwen Code, GitHub Copilot. Each reads the same score, plays its own part.

Symphonee itself is the hall, the baton, and the tempo.

---

## Why an Execution Engine, not another AI tool

Most AI tools stop at the suggestion. They write a plan and hand you a chat window. Symphonee assumes you already know what you want done, and focuses on the thing that is actually hard: making many tools, agents, and side effects cooperate without drifting.

- **Local-first.** Your repos, your machine, your permissions. The engine runs on `127.0.0.1:3800`.
- **Plugin-driven.** Core ships with terminal, recipes, notes, diffs, git, and repo management. Everything else is a plugin you install per project.
- **Multi-CLI.** One conductor, many players. Same score, different instruments.
- **Durable.** Graph runs survive restarts, branch on approval gates, and keep state across multi-hour sessions.
- **Permission-aware.** Four runtime modes (`review`, `edit`, `trusted`, `bypass`) enforced by the server, not by agent etiquette.

---

## Features

### The Shell (core)
- **Multi-AI Terminal.** Run Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Grok, or Qwen Code directly inside the app. Every session starts with a single bootstrap call so the agent knows the active repo, permission mode, installed plugins, and learnings before its first reply.
- **Git Operations.** Switch branches, pull, push, compare, and commit through the built-in UI. Side-by-side diff viewer with syntax highlighting.
- **File Browser and Monaco Code Viewer.** Browse repository files, search across codebases, view and edit files with full Monaco editor.
- **Markdown Notes.** Built-in scratchpad. AI agents can read and write notes too.
- **Command Palette.** `Ctrl+K` jumps to any action, tab, repository, recipe, or plugin surface. Type `find <query>` to search across notes and learnings.
- **Factory Reset + Export/Import.** One-click wipe of config, themes, notes, recipes, and installed plugins. Export bundle round-trips on import and auto-clones the plugins you used.

### The Orchestra (AI tooling)
- **Permission Modes.** Four modes (`review` / `edit` / `trusted` / `bypass`) gate every spawn, write, and external call at the server level. Pattern-based allow/ask/deny rules with one-click "always allow this pattern" promotion.
- **AI Orchestration** (BETA). The conductor dispatches work to other players (Codex, Gemini, Grok, Copilot) with circuit breaker, retry, escalation ladder, fan-out, worktree isolation, and durable graph runs.
- **Graph Runs** (BETA). Define multi-step workflows with worker, approval, and branch nodes. Survive app restarts. Auto-fallback to a different CLI on rate-limit or quota errors. Results auto-inject back into the launching terminal.
- **Model Router.** Picks the right CLI and model for each task intent (`quick-summary`, `deep-code`, `web-research`, etc.) based on your subscriptions and API keys. Auto-promotes to large-context models when input exceeds 200k tokens.
- **Recipes.** Reusable AI workflows declared as markdown files. Built-in editor (Monaco + variable library + icon picker + preview). Three universal defaults ship: Explain Codebase, Brainstorm Feature, Review My Changes.
- **MCP Server + Client.** Exposes Symphonee to Claude Desktop, Cursor, VS Code, Zed, etc. Consume external MCP servers (GitHub, Postgres, Slack, Linear, and so on) right inside the app.
- **Hybrid Search.** BM25 ranking across notes and learnings.
- **Repo Map.** Token-budgeted symbol map of any repo. Languages, layout, top files ranked by recent commits with extracted classes and functions.
- **Learnings Database.** Accumulated technical knowledge and past mistakes, fetched at session start so players do not repeat them.

### The Instruments (plugins)
Every integration (issue tracker, code host, CMS, analytics, etc.) ships as a plugin installed from a GitHub-backed registry. A plugin can contribute tabs, sidebar actions, scripts, MCP tools, AI actions and keywords, work-item and PR providers, repo sources, commit linkers, and its own config keys. Uninstall a plugin and its surfaces disappear cleanly. Core ships provider-agnostic; AI instructions for a plugin are fetched on demand only when that plugin is active.

Official instruments live in a separate repo: [`Symphonee-plugins`](https://github.com/matandessaur-me/Symphonee-plugins). Current roster: Azure DevOps, GitHub, Builder.io, Sanity, WordPress.

---

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or later
- [Git](https://git-scm.com/)

Provider credentials (Azure DevOps PAT, GitHub token, etc.) are only needed if you install the corresponding plugin.

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/matandessaur-me/Symphonee.git
   ```
2. **Open the folder** and double-click **`Install.cmd`**. This installs dependencies, sets up the app icon, and creates a desktop shortcut.
3. **Launch Symphonee** from the desktop shortcut.

Onboarding walks you through picking AI CLIs, browsing the plugin registry (with context-aware recommendations based on your local git remotes), and configuring only the credentials the plugins you chose actually need. A "Just the terminal" shortcut skips past plugin setup entirely.

> To change settings later, click the **Settings** button in the bottom-left corner of the app.

### Optional: AI players

For AI-powered features, install one or more of these CLIs globally:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) -- `npm i -g @anthropic-ai/claude-code`
- [Codex CLI](https://github.com/openai/codex) -- `npm i -g @openai/codex`
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) -- `npm i -g @google/gemini-cli`
- [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) -- `npm i -g @githubnext/github-copilot-cli`
- [Grok CLI](https://x.ai/api) -- community CLI; xAI official is on the waitlist as of April 2026
- [Qwen Code](https://github.com/QwenLM/qwen-code) -- `npm i -g @qwen-code/qwen-code`

Symphonee auto-detects which CLIs are installed and lets you switch between them per terminal tab.

---

## Architecture

```
Symphonee
+-- Electron Shell (electron-main.js)
|   +-- Loads http://127.0.0.1:3800
|
+-- Node.js Server (server.js, port 3800)
|   +-- REST API (/api/*)              -> Core services; plugin routes under /api/plugins/<id>/
|   +-- Permissions engine             -> Modes + pattern rules + approval queue
|   +-- Orchestrator                   -> Spawn / dispatch / handoff / fan-out / worktree
|   +-- Graph runs engine              -> Durable multi-step workflows
|   +-- Model router                   -> Intent-based CLI + model selection
|   +-- Recipes loader                 -> Markdown workflow files
|   +-- Hybrid search (BM25)           -> Notes + Learnings retrieval
|   +-- Repo map                       -> Token-budgeted symbol graph
|   +-- MCP server (stdio)             -> Exposes plugins + tools to external clients
|   +-- MCP client manager             -> Consumes external MCP servers
|   +-- Plugin loader                  -> Install from registry, mount routes, contribute UI / MCP / AI actions
|   +-- Learnings store                -> Accumulated technical knowledge
|   +-- WebSocket                      -> Terminal PTY bridge
|
+-- Dashboard UI (index.html)
|   +-- Header                         -> Permission mode chip + status
|   +-- Sidebar                        -> Core + plugin-contributed quick actions, AI actions
|   +-- Center tabs                    -> Terminal, Orchestrator, Files, Diff, Notes, Recipe Editor, plugin tabs
|   +-- Right intel panel              -> Recipes + plugin-contributed panels
|   +-- Monaco editor                  -> Code viewer + recipe editor + repo map viewer
|   +-- XTerm.js terminal              -> Multi-tab PTYs with AI launchers
|   +-- Approval modal                 -> Permissions + graph-run approval gates
|
+-- Scripts (scripts/)
    +-- 30+ PowerShell + Node helpers (work items, git, recipes, graph runs, etc.)
```

### How it works

1. The **Electron app** launches a local Node.js HTTP server on port 3800.
2. The **server** runs all core services and bridges the terminal over WebSocket. Every external integration is owned by a plugin mounted under `/api/plugins/<id>/`.
3. The **dashboard** is a single-page app with center tabs and a right-side intel panel. Monaco is used wherever code or markdown is shown or edited.
4. **AI players** in the terminal call the same internal API as the UI. Every session starts with a single `/api/bootstrap` fetch that returns context, instructions, plugins, learnings, and permission state in one round-trip.
5. **External AI clients** (Claude Desktop, Cursor, etc.) reach the same surface through the MCP server.

---

## Recipes (reusable AI workflows)

A recipe is a single markdown file with YAML frontmatter that bundles a recurring AI operation: which CLI/model (or just an intent for the model router), which plugins/MCP servers to enable, what permission mode to use, typed inputs, and a prompt template body. Recipes live in `recipes/` (project-local, committed) or `~/.symphonee/recipes/` (user-global).

Open the right intel panel -> **Recipes** tab to browse, create, edit, duplicate, preview, delete, or run any recipe. The built-in editor is a Monaco-based markdown editor with a clickable variable library on the right (context vars like Selected Repo, your declared inputs, plus snippets for common patterns).

**Three default recipes** ship with the app, all universal (no Azure DevOps or GitHub required):

| Recipe | What it does |
|---|---|
| **Explain This Codebase** | Reads README + manifest + entry points, produces a 6-section orientation brief |
| **Brainstorm a Feature** | Turn a one-line idea into user stories, edge cases, technical considerations, ordered implementation plan |
| **Review My Changes** | Pre-flight code review of your uncommitted git diff before pushing |

**Two delivery modes**:
- `inject` (default): rendered prompt is typed into the active terminal so the AI you're already working with handles it.
- `dispatch`: spawns a fresh headless worker via the orchestrator (requires AI Orchestration enabled).

Recipes can be invoked via the Recipes panel, the command palette (Ctrl+K), `./scripts/Run-Recipe.ps1`, or any MCP client that has the Symphonee MCP server connected (`run_recipe`, `list_recipes`, `preview_recipe`, etc.).

---

## MCP Server (Model Context Protocol)

Symphonee ships an MCP server so external AI clients (Claude Desktop, Cursor, VS Code Copilot, Zed, Goose, Warp, etc.) can use its core tools plus whatever each installed plugin contributes.

Launch it from your MCP client's config. The Symphonee app must be running.

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "symphonee": {
      "command": "node",
      "args": ["C:/Code/Personal/Symphonee/scripts/mcp-serve.js"]
    }
  }
}
```

**Cursor / VS Code / Zed**: point at the same command. Transport is stdio.

Core tools: `save_note`, `spawn_worker`, `search_learnings`, `list_repos`, `get_permission_mode`. Plugin-contributed tools (work items, PRs, CMS operations, etc.) are namespaced `<pluginId>__<toolName>` and appear automatically when the plugin is installed.

Core resources: `symphonee://context`, `symphonee://instructions`, `symphonee://learnings`, `symphonee://permissions`.

All mutating tools are gated by the active Symphonee permission mode (review / edit / trusted / bypass), with an in-app modal for approval.

### Plugins as MCP tools

Any installed plugin can declare tools, resources, and prompts in its `plugin.json` under `contributions.mcp`. They are automatically merged into Symphonee's MCP server with a namespaced name (`<pluginId>__<toolName>`), so an external MCP client can use plugin tools without ever opening Symphonee's UI.

### MCP client (consume external servers)

Symphonee can also connect to external MCP servers (GitHub, Postgres, Slack, Linear, Sentry, Figma, Notion, and hundreds more). Settings -> MCP Servers lets you add a server by command and args. Each server is launched as a child process over stdio, its capabilities are fetched and displayed, and its tools become callable via `/api/mcp/call`.

---

## Supported players

Symphonee detects installed CLIs at boot and lets you launch any of them per terminal tab. The Model Router picks the best CLI and model per task intent, respecting your installed CLIs and configured API keys.

| Player | Package | Notes |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | Anthropic. Haiku 4.5 / Sonnet 4.6 / Opus 4.6 / opusplan. |
| Codex CLI | `@openai/codex` | OpenAI. GPT-5.4 / GPT-5.4-mini / GPT-5.3-Codex / Spark. Native web search. |
| Gemini CLI | `@google/gemini-cli` | Google. Gemini 3 Flash (free tier) / Gemini 3 Pro (paid). 2M context. |
| GitHub Copilot CLI | `@githubnext/github-copilot-cli` | GitHub. Best for PR/issue workflows. |
| Grok | `x.ai` API | xAI. Community CLI only as of April 2026; official Grok CLI is on the waitlist. Live X/social context. |
| Qwen Code | `@qwen-code/qwen-code` | Alibaba. Long-context coding CLI. |

The visual theme is driven by your **theme preference** in Settings, not by which CLI is active.

---

## Tech Stack

- **Electron** v35 -- Desktop application shell
- **Node.js** -- HTTP server and core services (orchestrator, graph runs, recipes, permissions, plugin loader, MCP)
- **Monaco Editor** -- Code viewer, recipe editor, repo map viewer
- **XTerm.js** -- Terminal emulator with WebGL rendering
- **node-pty** -- Persistent PowerShell PTY sessions
- **WebSocket (ws)** -- Real-time terminal I/O bridge
- **Lucide Icons** -- UI iconography
- **Highlight.js** -- Syntax highlighting for diffs
- **Model Context Protocol** -- Open standard for AI tool/resource integration (server + client)

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). Anyone who modifies and distributes this software, including offering it as a network service, must also open-source their changes under the same license.

Copyright (c) 2026 Matan Dessaur.

---

*Built with frustration at tab-switching and love for developer tooling.*
