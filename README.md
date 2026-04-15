<img src="https://repository-images.githubusercontent.com/1187508410/001d4330-d22f-4655-bb5f-0cb51022fdab" alt="devopspilot-logo"/>
# DevOps Pilot

**An AI-powered Azure DevOps workstation built on Electron.**

DevOps Pilot is a desktop application that brings together Azure DevOps project management, a built-in terminal with AI agent support, git operations, and a full-featured code/diff viewer — all in one window. It's designed for developers who want to manage sprints, work items, and code without constantly switching between browser tabs and terminal windows.

> Created and maintained by **[Matan Dessaur](https://github.com/M8N-MatanDessaur)**

---

## Features

### Core
- **Sprint & Work Item Management** — Board, backlog, burndown, velocity. Create, update, and move work items through their lifecycle.
- **Multi-AI Terminal** — Run Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Grok, or Qwen Code directly inside the app. Agents get full context of your Azure DevOps project at session start.
- **Git Operations** — Switch branches, pull, push, compare, and commit through the built-in UI. Side-by-side diff viewer with syntax highlighting.
- **File Browser & Monaco Code Viewer** — Browse repository files, search across codebases, view and edit files with full Monaco editor (the editor that powers VS Code).
- **Markdown Notes** — Built-in scratchpad. AI agents can read and write notes too.
- **Command Palette** — `Ctrl+K` jumps to any action, tab, repository, work item, or recipe. Type `find <query>` to search across notes and learnings.
- **Activity Timeline & Pull Requests** — Recent work item changes with charts; review and create GitHub PRs without leaving the app.

### AI tooling
- **Permission Modes** — Four modes (`review` / `edit` / `trusted` / `bypass`) gate every spawn, write, and external call at the server level. Pattern-based allow/ask/deny rules with one-click "always allow this pattern" promotion. Header chip switches mode; approval modal appears when needed.
- **AI Orchestration** (BETA) — Lead AI dispatches work to other CLIs (Codex, Gemini, Grok, Copilot) with circuit breaker, retry, escalation ladder, fan-out, worktree isolation, and durable graph runs.
- **Graph Runs** (BETA, part of Orchestration) — Define multi-step workflows with worker, approval, and branch nodes. Survive app restarts. Auto-fallback to a different CLI on rate-limit/quota errors. Result auto-injects back into the launching terminal.
- **Model Router** — Picks the right CLI + model for each task intent (`quick-summary`, `deep-code`, `web-research`, etc.) based on your subscriptions and API keys. Auto-promotes to large-context models when input exceeds 200k tokens.
- **Recipes** — Reusable AI workflows declared as markdown files. Built-in editor (Monaco + variable library + icon picker + preview). Three universal defaults ship: Explain Codebase, Brainstorm Feature, Review My Changes.
- **MCP Server + Client** — Exposes DevOps Pilot to Claude Desktop, Cursor, VS Code, Zed, etc. Consume external MCP servers (GitHub, Postgres, Slack, Linear, etc.) right inside the app.
- **Hybrid Search** — BM25 ranking across notes and learnings. Use the Notes search box (notes only) or the palette `find` command (notes + learnings).
- **Repo Map** — Token-budgeted symbol map of any repo. Languages, layout, top files ranked by recent commits with extracted classes and functions. Use it before grepping unfamiliar code. AI Action button in the sidebar.
- **Plugins** — Builder.io, Sanity, WordPress, GA4/GTM, Release Manager, Dependency Inspector, Environment Manager, and more. Each plugin can contribute tabs, scripts, MCP tools, and AI keywords.
- **Learnings Database** — Accumulated technical knowledge and past mistakes, fetched at session start so the AI doesn't repeat them.



## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Git](https://git-scm.com/)
- An [Azure DevOps](https://dev.azure.com/) organization with a Personal Access Token (PAT)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/M8N-MatanDessaur/DevOps-Pilot.git
   ```

2. **Open the folder** and double-click **`Install.cmd`**

   This installs all dependencies, sets up the app icon, and creates a desktop shortcut.

3. **Launch DevOps Pilot** from the desktop shortcut

That's it. The app will walk you through connecting your Azure DevOps organization on first launch.

> To change settings later, click the **Settings** button in the bottom-left corner of the app.

### Optional: AI Agents

For AI-powered features, install one or more of these CLIs globally:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm i -g @anthropic-ai/claude-code`
- [Codex CLI](https://github.com/openai/codex) — `npm i -g @openai/codex`
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `npm i -g @google/gemini-cli`
- [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) — `npm i -g @githubnext/github-copilot-cli`
- [Grok CLI](https://x.ai/api) — community CLI; xAI official is on the waitlist as of April 2026

The app auto-detects which CLIs are installed and lets you switch between them. Each session starts with a single bootstrap call so the AI knows the active repo, permission mode, plugins, and learnings before its first reply.

---

## Architecture

```
DevOps Pilot
+-- Electron Shell (electron-main.js)
|   +-- Loads http://localhost:3800
|
+-- Node.js Server (server.js, port 3800)
|   +-- REST API (/api/*)              -> Azure DevOps + GitHub proxy, all internal services
|   +-- Permissions engine             -> Modes + pattern rules + approval queue
|   +-- Orchestrator                   -> Spawn / dispatch / handoff / fan-out / worktree
|   +-- Graph runs engine              -> Durable multi-step workflows
|   +-- Model router                   -> Intent-based CLI + model selection
|   +-- Recipes loader                 -> Markdown workflow files
|   +-- Hybrid search (BM25)           -> Notes + Learnings retrieval
|   +-- Repo map                       -> Token-budgeted symbol graph
|   +-- MCP server (stdio)             -> Exposes plugins + tools to external clients
|   +-- MCP client manager             -> Consumes external MCP servers
|   +-- Plugin loader                  -> Auto-discovers + mounts plugin routes
|   +-- Learnings store                -> Accumulated technical knowledge
|   +-- WebSocket                      -> Terminal PTY bridge
|
+-- Dashboard UI (index.html)
|   +-- Header                         -> Permission mode chip + status
|   +-- Sidebar                        -> Boards, AI actions, plugins, git
|   +-- Center tabs                    -> Terminal, Backlog, Work Item, PRs, Files, Diff,
|   |                                     Notes, Recipe Editor, plugin tabs
|   +-- Right intel panel              -> Activity, Team, Git Log, Recipes
|   +-- Monaco editor                  -> Code viewer + recipe editor + repo map viewer
|   +-- XTerm.js terminal              -> Multi-tab PTYs with AI launchers
|   +-- Approval modal                 -> Permissions + graph-run approval gates
|
+-- Scripts (scripts/)
    +-- 30+ PowerShell + Node helpers (work items, git, recipes, graph runs, etc.)
```

### How It Works

1. The **Electron app** launches a local Node.js HTTP server on port 3800.
2. The **server** proxies Azure DevOps and GitHub APIs, runs all internal services (orchestrator, graph runs, recipes, search, MCP server, plugins, learnings), and bridges the terminal over WebSocket.
3. The **dashboard** is a single-page app with center tabs and a right-side intel panel. Monaco is used wherever code or markdown is shown or edited.
4. **AI agents** in the terminal call the same internal API as the UI. Every session starts with a single `/api/bootstrap` fetch that returns context, instructions, plugins, learnings, and permission state in one round-trip.
5. **External AI clients** (Claude Desktop, Cursor, etc.) reach the same surface through the MCP server.

---

## Recipes (reusable AI workflows)

A recipe is a single markdown file with YAML frontmatter that bundles a recurring AI operation: which CLI/model (or just an intent for the model router), which plugins/MCP servers to enable, what permission mode to use, typed inputs, and a prompt template body. Recipes live in `recipes/` (project-local, committed) or `~/.devops-pilot/recipes/` (user-global).

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

Recipes can be invoked via the Recipes panel, the command palette (Ctrl+K), `./scripts/Run-Recipe.ps1`, or any MCP client that has the DevOps Pilot MCP server connected (`run_recipe`, `list_recipes`, `preview_recipe`, etc.).

---

## MCP Server (Model Context Protocol)

DevOps Pilot ships an MCP server so external AI clients (Claude Desktop, Cursor, VS Code Copilot, Zed, Goose, Warp, etc.) can use its work item management, sprint queries, notes, orchestrator, and learnings database as tools and resources.

Launch it from your MCP client's config. The DevOps Pilot app must be running.

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "devops-pilot": {
      "command": "node",
      "args": ["C:/Code/Personal/DevOps-Pilot/scripts/mcp-serve.js"]
    }
  }
}
```

**Cursor / VS Code / Zed**: point at the same command. Transport is stdio.

Exposed tools: `list_work_items`, `get_work_item`, `create_work_item`, `set_work_item_state`, `get_sprint_status`, `save_note`, `spawn_worker`, `search_learnings`, `list_repos`, `get_permission_mode`.

Exposed resources: `devops-pilot://context`, `devops-pilot://instructions`, `devops-pilot://learnings`, `devops-pilot://permissions`.

Exposed prompts: `standup_summary`, `retro_analysis`.

All mutating tools are gated by the active DevOps Pilot permission mode (review / edit / trusted / bypass), with an in-app modal for approval.

### Plugins as MCP tools

Any installed plugin can declare tools, resources, and prompts in its `plugin.json` under `contributions.mcp`. They are automatically merged into DevOps Pilot's MCP server with a namespaced name (`<pluginId>__<toolName>`), so a Claude Desktop user can use Builder.io plugin tools without ever opening DevOps Pilot's UI.

Example (`dashboard/plugins/builderio/plugin.json`):
```json
"contributions": {
  "mcp": {
    "tools": [
      {
        "name": "health",
        "description": "Builder.io project health check.",
        "inputSchema": { "type": "object", "properties": {} },
        "route": "GET /api/plugins/builderio/health"
      }
    ]
  }
}
```

### MCP client (consume external servers)

DevOps Pilot can also connect to external MCP servers (GitHub, Postgres, Slack, Linear, Sentry, Figma, Notion, and hundreds more). Settings -> MCP Servers lets you add a server by command and args. Each server is launched as a child process over stdio, its capabilities are fetched and displayed, and its tools become callable via `/api/mcp/call`.

---

## Supported AI Agents

DevOps Pilot detects installed CLIs at boot and lets you launch any of them per terminal tab. The Model Router picks the best CLI + model per task intent, respecting your installed CLIs and configured API keys.

| Agent | Package | Notes |
|-------|---------|-------|
| Claude Code | `@anthropic-ai/claude-code` | Anthropic. Models: Haiku 4.5 / Sonnet 4.6 / Opus 4.6 / opusplan. |
| Codex CLI | `@openai/codex` | OpenAI. Models: GPT-5.4 / GPT-5.4-mini / GPT-5.3-Codex / Spark. Native web search. |
| Gemini CLI | `@google/gemini-cli` | Google. Models: Gemini 3 Flash (free tier) / Gemini 3 Pro (paid). 2M context. |
| GitHub Copilot CLI | `@githubnext/github-copilot-cli` | GitHub. Best for PR/issue workflows. |
| Grok | `x.ai` API | xAI. Community CLI only as of April 2026; official Grok CLI is on the waitlist. Unique edge: live X/social context. |

The visual theme is driven by your **theme preference** in Settings (Catppuccin variants and others), not by which CLI is active.

---

## Tech Stack

- **Electron** v35 — Desktop application shell
- **Node.js** — HTTP server, internal services, Azure DevOps + GitHub proxy
- **Monaco Editor** — Code viewer, recipe editor, repo map viewer
- **XTerm.js** — Terminal emulator with WebGL rendering
- **node-pty** — Persistent PowerShell PTY sessions
- **WebSocket (ws)** — Real-time terminal I/O bridge
- **Lucide Icons** — UI iconography
- **Highlight.js** — Syntax highlighting for diffs
- **Model Context Protocol** — Open standard for AI tool/resource integration (server + client)

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). This means anyone who modifies and distributes this software — including offering it as a network service — must also open-source their changes under the same license.

Copyright (c) 2026 Matan Dessaur.

---

*Built with frustration at tab-switching and love for developer tooling.*
