# Recipes

Recipes are reusable markdown files that bundle a recurring AI operation: which CLI/model (or just an intent for the model router), which plugins/MCP servers to enable, what permission mode to use, typed inputs, and a prompt template body.

## Where they live

- `recipes/` at the repo root - project-local, committed and shared with the team
- `~/.symphonee/recipes/` - user-global, available across projects (project-local wins on name conflict)

## Format

```yaml
---
name: Explain This Codebase                  # display name
description: One-line description
icon: book-open                               # lucide icon
intent: deep-code                             # for the model router; OR set cli/model directly
mode: edit                                    # advisory; recipe suggests, user controls the chip
plugins: [release-manager]                    # plugins the recipe expects to use
mcpServers: [github]                          # external MCP servers it expects
dispatch: false                               # true = spawn headless worker (needs orchestration); false (default) = inject into active terminal
inputs:
  - name: repo
    type: repo                                # smart selector; renders a dropdown of /api/repos
    default: "{{ context.activeRepo }}"
    required: true
---

Body of the prompt. Supports {{ inputs.X }}, {{ context.X }}, {{ env.X }}.
```

## Input types

Free-text:
- `string` - text input, default empty
- `number` - numeric input
- `boolean` - checkbox

Smart selectors (modal renders a populated dropdown with the active value pre-selected):
- `repo` - dropdown of all configured repos from `/api/repos`. Active repo marked.
- Plugin-provided selectors (iteration, sprint, work-item picker, etc.) -- each plugin registers its own selector types via its `contributions.inputTypes`. If the required plugin is not installed, the selector renders empty and the recipe can fall back to a plain text input.
- `select` with `choices: [...]` - explicit list of options

The modal always shows a "Will run with" panel above the inputs, displaying the active repo / iteration / AI so the user knows what context the recipe will see — even when the recipe declares no inputs.

## Creating a new recipe

Two ways:

**1. UI editor (recommended for humans):** right-side intel panel -> Recipes tab -> **+ New Recipe** button. Opens a closable center tab with form fields for the frontmatter, an inputs builder, a markdown body editor, and a clickable variable library on the right (context vars, your declared inputs, and common snippets). Save writes a file to `recipes/<filename>.md`.

**2. Direct file write (for AI agents):** drop a markdown file into `recipes/<id>.md` matching the format above. The library auto-rescans every 60 seconds; users can also click Rescan in the panel. To save via the API:

```bash
curl -s -X POST http://127.0.0.1:3800/api/recipes/save \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-recipe",
    "frontmatter": { "name": "My Recipe", "description": "...", "intent": "deep-code", "inputs": [...] },
    "body": "Prompt body with {{ inputs.X }} substitution"
  }'
```

## Scripts (primary surface)

```bash
./scripts/Get-Recipes.ps1                                # list
./scripts/Get-Recipes.ps1 -Id sprint-review              # detail
./scripts/Run-Recipe.ps1 -Id sprint-review               # run with defaults
./scripts/Run-Recipe.ps1 -Id release-notes -Inputs '{"version":"3.1.0"}'
```

## API

- `GET /api/recipes` - list
- `GET /api/recipes/:id` - detail
- `POST /api/recipes/run` with `{ id, inputs, originTermId? }` - run, returns `{ recipe, cli, model, taskId }`

## Behavior

### Two delivery modes

- **`inject` (default)**: the rendered prompt is sent to the active terminal as if the user typed it. The currently running AI (Claude Code, Codex, Gemini, Copilot, Grok) handles it. Works whether AI Orchestration is on or off.
- **`dispatch`**: spawns a headless worker via the orchestrator. Set `dispatch: true` in the recipe frontmatter to opt in. **Requires AI Orchestration to be enabled** (Settings -> Other). Returns a task id; result is injected back when the worker completes.

Use **dispatch** when you want the work to run in parallel without occupying your terminal (for example, a long backlog audit while you keep coding). Use the default **inject** mode for everything else.

### Other notes

- If `intent` is set and `cli` is omitted, the model router picks the CLI/model that fits. Only matters in dispatch mode (inject mode uses whatever AI is already running in your terminal).
- If `cli` (and optionally `model`) is set, that pick is used as-is in dispatch mode.
- The recipe's `mode` field is **advisory** in v1: the active permission mode chip still controls server-side gating. The runner reports the advised mode so the user can switch the chip if needed.

## Starter recipes shipped

- `explain-codebase` - summarise an active repo for a new reader
- `what-changed-recently` - git-log summary of activity over the last N days
- `find-todos` - ripgrep TODO / FIXME / HACK comments and triage by severity
- `smoke-test-shell` - 16-point validation of the plugin-first shell (core primitives, plugin gates, export surface). Read-only diagnostic.

All four depend only on the core shell (git, ripgrep, notes, scripts) -- no plugin required. Plugins may ship their own recipes; installed plugins surface theirs through `/api/recipes`.

## When to write a recipe vs. a graph run

- **Recipe**: single worker call, repeatable rituals, "do X with the right CLI". One step.
- **Graph run**: multi-step with branching, approval gates, or durability needs. Many steps.

A recipe can launch a graph run via its body if the body invokes `./scripts/Start-GraphRun.ps1`.
