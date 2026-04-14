<img src="https://repository-images.githubusercontent.com/1187508410/001d4330-d22f-4655-bb5f-0cb51022fdab" alt="devopspilot-logo"/>
# DevOps Pilot

**An AI-powered Azure DevOps workstation built on Electron.**

DevOps Pilot is a desktop application that brings together Azure DevOps project management, a built-in terminal with AI agent support, git operations, and a full-featured code/diff viewer — all in one window. It's designed for developers who want to manage sprints, work items, and code without constantly switching between browser tabs and terminal windows.

> Created and maintained by **[Matan Dessaur](https://github.com/M8N-MatanDessaur)**

---

## Features

- **Sprint & Work Item Management** — View your board, backlog, burndown charts, and velocity. Create, update, and move work items through their lifecycle.
- **AI-Powered Terminal** — Run Claude Code, Gemini CLI, GitHub Copilot CLI, or OpenAI Codex directly inside the app. AI agents have full context of your Azure DevOps project.
- **Git Operations** — Switch branches, pull, push, compare, and commit — all through the built-in UI. View diffs with syntax-highlighted side-by-side comparison.
- **File Browser & Code Viewer** — Browse repository files, search across codebases, and view files with syntax highlighting.
- **Markdown Notes** — Built-in scratchpad for meeting notes, sprint planning, and documentation. AI agents can read and write notes too.
- **Command Palette** — Press `Ctrl+K` to instantly jump to any action, tab, repository, or work item.
- **Activity Timeline** — Visual overview of recent work item changes with charts and daily activity.
- **Pull Request Management** — View, review, and create GitHub pull requests without leaving the app.



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
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `npm i -g @google/gemini-cli`
- [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) — `npm i -g @githubnext/github-copilot-cli`
- [Codex CLI](https://github.com/openai/codex) — `npm i -g @openai/codex`

The app auto-detects which CLIs are installed and lets you switch between them.

---

## Architecture

```
DevOps Pilot
+-- Electron Shell (electron-main.js)
|   +-- Loads http://localhost:3800
|
+-- Node.js Server (server.js, port 3800)
|   +-- REST API (/api/*)          -> Azure DevOps proxy
|   +-- WebSocket                  -> Terminal PTY bridge
|   +-- Git handlers               -> Local repo operations
|   +-- Static files               -> Dashboard UI
|
+-- Dashboard UI (index.html)
|   +-- Board & Backlog views
|   +-- Work item detail/create modals
|   +-- XTerm.js terminal (WebGL)
|   +-- File browser & code viewer
|   +-- Diff viewer (split & unified)
|   +-- Git modal (branches, pull, push, commit, compare)
|   +-- Markdown notes editor
|   +-- Settings modal
|
+-- PowerShell Scripts (scripts/)
    +-- Utility scripts for AI agents
```

### How It Works

1. The **Electron app** launches a local Node.js HTTP server on port 3800.
2. The **server** proxies Azure DevOps REST API calls using your PAT, manages local git operations, serves the dashboard UI, and bridges a WebSocket connection to a persistent PowerShell PTY.
3. The **dashboard** is a single-page app with the board, backlog, terminal, file browser, diff viewer, and notes editor.
4. **AI agents** run inside the terminal and interact with the app through the REST API and pre-made PowerShell scripts.

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

Each AI agent gets its own themed color palette when active:

| Agent | Theme Color | Package |
|-------|------------|---------|
| Claude Code | Orange | `@anthropic-ai/claude-code` |
| Gemini CLI | Blue | `@google/gemini-cli` |
| Copilot CLI | Purple | `@githubnext/github-copilot-cli` |
| Codex CLI | Green | `@openai/codex` |

---

## Tech Stack

- **Electron** v35 — Desktop application shell
- **Node.js** — HTTP server and Azure DevOps API proxy
- **XTerm.js** — Terminal emulator with WebGL rendering
- **node-pty** — Persistent PowerShell PTY sessions
- **WebSocket (ws)** — Real-time terminal I/O bridge
- **Lucide Icons** — UI iconography
- **Highlight.js** — Syntax highlighting for code viewer and diffs

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). This means anyone who modifies and distributes this software — including offering it as a network service — must also open-source their changes under the same license.

Copyright (c) 2026 Matan Dessaur.

---

*Built with frustration at tab-switching and love for developer tooling.*
