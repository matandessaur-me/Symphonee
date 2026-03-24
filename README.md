# DevOps Pilot

**An AI-powered Azure DevOps workstation built on Electron.**

DevOps Pilot is a desktop application that brings together Azure DevOps project management, a built-in terminal with AI agent support, git operations, and a full-featured code/diff viewer — all in one window. It's designed for developers who want to manage sprints, work items, and code without constantly switching between browser tabs and terminal windows.

> Created by **Matan Dessaur**

---

## What It Does

- **Sprint & Work Item Management** — View your board, backlog, burndown charts, and velocity. Create, update, and move work items through their lifecycle without leaving the app.
- **AI-Powered Terminal** — Run Claude Code, Gemini CLI, GitHub Copilot CLI, or OpenAI Codex directly inside the app. The AI agents have full context of your Azure DevOps project and can create work items, generate standup summaries, run retrospectives, and manage git operations on your behalf.
- **Git Operations** — Switch branches, pull, push, and compare branches through a built-in modal. Commit with custom messages or let AI generate them. View diffs with syntax-highlighted side-by-side comparison.
- **File Browser & Code Viewer** — Browse repository files, search across codebases, and view files with syntax highlighting — all without opening an external editor.
- **Markdown Notes** — A built-in scratchpad for meeting notes, sprint planning, and documentation. AI agents can read and write notes too.
- **Command Palette** — Press `Ctrl+K` or click the search bar at the top to instantly jump to any action, tab, repository, or work item. Fuzzy search across everything.
- **Activity Timeline** — Visual overview of recent work item changes with charts showing status breakdown and daily activity. Filter by 5, 14, or 30 days. Auto-updates when you change iterations.
- **Voice Input** — Optional Wispr Flow integration for voice-to-text input anywhere in the app — terminal, search bars, notes editor, or code viewer.

## Screenshots

*Coming soon*

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Git](https://git-scm.com/)
- An [Azure DevOps](https://dev.azure.com/) organization with a Personal Access Token (PAT)
- At least one AI CLI installed (optional but recommended):
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm i -g @anthropic-ai/claude-code`
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `npm i -g @google/gemini-cli`
  - [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli) — `npm i -g @githubnext/github-copilot-cli`
  - [Codex CLI](https://github.com/openai/codex) — `npm i -g @openai/codex`

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/M8N-MatanDessaur/DevOps-Pilot.git
   cd DevOps-Pilot
   ```

2. Run the installer:
   ```
   Install.cmd
   ```
   This handles everything — checks for Node.js, installs dependencies, sets up PowerShell execution policy, and generates the app icon.

3. Launch the app:
   ```bash
   npm run electron
   ```

4. **Follow the onboarding.** The app will walk you through connecting your Azure DevOps organization, adding your PAT, and configuring your repositories.

That's it. If you need to change anything later, click the **Settings** button in the bottom-left corner of the app.

### Building a Portable Executable

```bash
npm run dist
```

This produces a portable `.exe` in the `dist/` folder using electron-builder.

---

## Architecture

```
DevOps Pilot
├── Electron Shell (electron-main.js)
│   └── Loads http://localhost:3800
│
├── Node.js Server (server.js, port 3800)
│   ├── REST API (/api/*)          → Azure DevOps proxy
│   ├── WebSocket                  → Terminal PTY bridge
│   ├── Git handlers               → Local repo operations
│   └── Static files               → Dashboard UI
│
├── Dashboard UI (index.html)
│   ├── Board & Backlog views
│   ├── Work item detail/create modals
│   ├── XTerm.js terminal (WebGL)
│   ├── File browser & code viewer
│   ├── Diff viewer (split & unified)
│   ├── Git modal (branches, pull, push, commit, compare)
│   ├── Markdown notes editor
│   └── Settings modal
│
└── PowerShell Scripts (scripts/)
    └── 15 utility scripts for AI agents
```

### How It Works

1. The **Electron app** launches a local Node.js HTTP server on port 3800.
2. The **server** proxies Azure DevOps REST API calls using your PAT, manages local git operations, serves the dashboard UI, and bridges a WebSocket connection to a persistent PowerShell PTY.
3. The **dashboard** is a single-page app that provides the board, backlog, terminal, file browser, diff viewer, and notes editor.
4. **AI agents** run inside the terminal and interact with the app through the REST API and pre-made PowerShell scripts. They can read/write work items, navigate the UI, open diffs, and save notes.

---

## Supported AI Agents

Each AI agent gets its own themed color palette when active:

| Agent | Theme Color | Package |
|-------|------------|---------|
| Claude Code | Orange | `@anthropic-ai/claude-code` |
| Gemini CLI | Blue | `@google/gemini-cli` |
| Copilot CLI | Purple | `@githubnext/github-copilot-cli` |
| Codex CLI | Green | `@openai/codex` |

The app auto-detects which CLIs are installed and lets you switch between them. Each agent has its own instruction file (`CLAUDE.md`, `GEMINI.md`, etc.) that teaches it how to use the app's API and scripts.

---

## API Reference

The server exposes a REST API at `http://127.0.0.1:3800/api/` that both the dashboard UI and AI agents use.

### Work Items
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/workitems?iteration={path}` | List work items (filterable by iteration, state, type, assignedTo) |
| `GET` | `/api/workitems/{id}` | Get full work item details |
| `POST` | `/api/workitems/create` | Create a work item |
| `PATCH` | `/api/workitems/{id}` | Update work item fields |
| `PATCH` | `/api/workitems/{id}/state` | Change work item state |
| `POST` | `/api/pull-request` | Create an Azure DevOps pull request |

### Sprints & Velocity
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/iterations` | List all sprints (current sprint is marked) |
| `GET` | `/api/velocity` | Velocity data for last 10 completed sprints |
| `GET` | `/api/burndown?iteration={path}` | Burndown data for a specific sprint |

### Git
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/git/status?repo={name}` | Current branch and changed files |
| `GET` | `/api/git/branches?repo={name}` | List local branches |
| `GET` | `/api/git/log?repo={name}` | Recent commits |
| `GET` | `/api/git/diff?repo={name}&path={file}` | Unified diff output |
| `POST` | `/api/git/fetch` | Fetch remote + list all branches |
| `POST` | `/api/git/checkout` | Switch branch |
| `POST` | `/api/git/pull` | Pull latest from remote |
| `POST` | `/api/git/push` | Push current branch |

### Other
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/team-members` | List team members |
| `GET` | `/api/config` | Current configuration |
| `GET/POST` | `/api/notes/*` | Read, create, save, delete markdown notes |
| `POST` | `/api/ui/*` | Control dashboard navigation (switch tabs, open work items, view files) |
| `GET` | `/api/files/tree?repo={name}` | File tree for a repository |
| `GET` | `/api/files/search?repo={name}&q={query}` | Search files by name |
| `POST` | `/api/start-working` | Start working on a work item (creates branch, sets Active) |

---

## PowerShell Scripts

Pre-made scripts in `scripts/` that AI agents (and you) can use:

| Script | What It Does |
|--------|-------------|
| `Get-SprintStatus.ps1` | Current sprint overview with item counts and progress |
| `Get-StandupSummary.ps1` | Standup summary — recently changed items grouped by state |
| `Get-Retrospective.ps1` | Sprint retrospective analysis |
| `Get-WorkItem.ps1` | Full details for a specific work item |
| `Get-MyWorkItems.ps1` | Your assigned items grouped by state |
| `New-WorkItem.ps1` | Create a new work item (User Story, Bug, Task, etc.) |
| `Find-WorkItems.ps1` | Search and filter work items |
| `Set-WorkItemState.ps1` | Move a work item between states |
| `Commit-Changes.ps1` | Stage and commit with automatic AB# linking |
| `Push-AndPR.ps1` | Push and create a pull request in one shot |
| `New-PullRequest.ps1` | Create an Azure DevOps pull request |
| `Show-Diff.ps1` | Open the built-in diff viewer |
| `Save-Note.ps1` | Save a markdown note to the scratchpad |
| `Refresh-Board.ps1` | Refresh the work items list in the dashboard |
| `Run-Query.ps1` | Execute a custom PowerShell query script |

---

## Project Structure

```
DevOps-Pilot/
├── dashboard/
│   ├── electron-main.js           # Electron app entry point
│   ├── server.js                  # REST API server + WebSocket bridge
│   └── public/
│       └── index.html             # Single-page dashboard UI
├── scripts/                       # PowerShell utility scripts for AI agents
├── config/
│   ├── config.json                # Your configuration (gitignored)
│   └── config.template.json       # Configuration template
├── notes/                         # Markdown notes storage
├── .ai-workspace/                 # Temporary AI workspace
├── .github/
│   └── copilot-instructions.md    # GitHub Copilot instructions
├── CLAUDE.md                      # Claude Code instructions (bash)
├── GEMINI.md                      # Gemini CLI instructions (PowerShell)
├── AGENTS.md                      # Generic agent instructions (PowerShell)
├── INSTRUCTIONS.md                # Master AI instructions file
├── Install.cmd                    # Windows installer script
└── package.json
```

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

This project is proprietary software. All rights reserved.

---

*Built with frustration at tab-switching and love for developer tooling.*
