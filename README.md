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

Copyright (c) 2025 Matan Dessaur.

---

*Built with frustration at tab-switching and love for developer tooling.*
