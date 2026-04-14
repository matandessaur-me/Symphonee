# Recipes

Recipes are reusable markdown files that bundle a recurring AI operation: which CLI/model (or just an intent for the model router), which plugins/MCP servers to enable, what permission mode to use, typed inputs, and a prompt template body.

## Where they live

- `recipes/` at the repo root - project-local, committed and shared with the team
- `~/.devops-pilot/recipes/` - user-global, available across projects (project-local wins on name conflict)

## Format

```yaml
---
name: Sprint Review                          # display name
description: One-line description
icon: clipboard-list                          # lucide icon
intent: deep-code                             # for the model router; OR set cli/model directly
mode: edit                                    # advisory; recipe suggests, user controls the chip
plugins: [release-manager]                    # plugins the recipe expects to use
mcpServers: [github]                          # external MCP servers it expects
inputs:
  - name: iteration
    type: string                              # string | number | boolean
    default: "{{ context.selectedIterationName }}"
    required: true
---

Body of the prompt. Supports {{ inputs.X }}, {{ context.X }}, {{ env.X }}.
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

- `sprint-review` - closed work items + grouped summary, saved as a note
- `standup-summary` - last-N-hours activity grouped by engineer
- `release-notes` - work items + merged PRs into versioned notes

## When to write a recipe vs. a graph run

- **Recipe**: single worker call, repeatable rituals, "do X with the right CLI". One step.
- **Graph run**: multi-step with branching, approval gates, or durability needs. Many steps.

A recipe can launch a graph run via its body if the body invokes `./scripts/Start-GraphRun.ps1`.
