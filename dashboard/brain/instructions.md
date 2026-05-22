# Symphonee Brain

The brain is the reasoning layer above Mind. Mind is memory; the brain
reads memory, classifies inputs, picks tools, and (when active) dispatches.

CLIs (Claude Code, Codex, Gemini, Grok, Qwen, Copilot) are TOOLS the brain
can call via the orchestrator. The brain does not replace frontier models -
it conducts them.

## Two tiers

- Tier 1 - planner triage. `qwen2.5:1.5b` by default. Sub-second routing
  decision on every input. Returns intent, primary_cli, needed_tools,
  rationale, confidence.
- Tier 2 - reasoning. `gemma4:26b` by default. Used when triage confidence
  is below 0.7 and for off-hot-path work (intent updates, workflow
  synthesis, opinion checks).

Both go through `dashboard/mind/llm.js`. Models can be overridden with
`SYMPHONEE_TRIAGE_MODEL` and `SYMPHONEE_REASONING_MODEL`.

## Planner modes

Two modes:

- `smart` (default) - brain observes, maintains intent, classifies inputs,
  logs decisions when asked. Does NOT override the orchestrator's CLI
  selection. The `/api/symphonee/think` endpoint and the brain-driven
  intent updates are fully active. Audit decisions via
  `GET /api/symphonee/decisions`.
- `active` - everything `smart` does, plus the orchestrator consults
  `brain.plan()` when `/api/orchestrator/spawn` is called without a
  `cli`. The brain's `primary_cli` choice fills in the gap.

Legacy values ("off", "shadow") in existing configs are read as `smart`
so the brain keeps working without a migration step.

Flip mode in settings (`SymphoneeBrain.plannerMode`) or via the topbar
brain chip.

## Intent state

A single global `intent` record persisted at `.symphonee/intent.json`.
Fields:

- `summary` - one-sentence theory of the current task
- `confidence` - 0..1
- `currentRepo` - which repo the user is in
- `lastUpdated` / `lastEventAt` - timestamps
- `evidence` - last 12 events feeding the current theory
- `history` - rolling 20-entry log of past summaries

Updated by `intent.notify({ kind, detail, repo, file, source })` from:
- file watcher (kind: `file-change`)
- drawer turn writes (kind: `drawer-turn`)
- save-result (kind: `qa-saved`)
- git activity (kind: `git-event`)

Debounced 5s so bursts of file events do not thrash `gemma4:26b`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | /api/symphonee/think | Planner front door. Body: `{ input }`. |
| GET  | /api/symphonee/decisions | Recent planner decisions (audit log). |
| GET  | /api/symphonee/intent | Current intent state. |
| POST | /api/symphonee/intent/notify | Push an event. |
| POST | /api/symphonee/intent/recompute | Force recompute (uses pending evidence). |
| POST | /api/symphonee/intent/pause | Pause auto-recompute. |
| POST | /api/symphonee/intent/resume | Resume. |
| GET  | /api/symphonee/status | Mode + models + decision count + current intent. |
| GET  | /api/symphonee/instructions | This file. |

## How other CLIs should use it

1. Read `intent.summary` from `bootstrap.brain.intent` (added to bootstrap)
   when answering the user. The intent tells you what the user is *doing*,
   independent of the literal question. Use it to resolve ambiguity.
2. Teach the brain by calling `POST /api/symphonee/intent/notify` with a
   `qa-saved` event after substantive answers. This is mostly automatic
   (server-side hooks fire on save-result) but explicit notification is
   allowed.
3. Never bypass the planner in `active` mode without a documented reason.

## Why the brain exists

Before: each CLI re-derives intent from the literal prompt and asks Mind
on its own. Two CLIs answering the same user can route very differently.

After: one Symphonee-owned theory of what the user is doing, used by every
CLI in the session and persisted across sessions.

## Constraint

This system does NOT assume the machine stays on. Intent updates and
planner decisions run only on events (input arrives, file changes, drawer
turn, save-result). Nothing schedules on a clock.
