# Symphonee Brain

The brain is the reasoning layer above Mind. Mind is memory; the brain
reads memory, classifies inputs, picks tools, and routes work.

CLIs (Claude Code, Codex, Gemini, Grok, Qwen, Copilot) are TOOLS the brain
calls via the orchestrator. The brain does not replace frontier models -
it conducts them.

## Always on

There is no off switch and no mode toggle. The brain is always observing,
always maintaining intent, always available for the orchestrator to
consult. When `/api/orchestrator/spawn` is called without a `cli`, the
brain picks one. Pass an explicit `cli` to bypass.

Older configs may still contain `SymphoneeBrain.plannerMode`. The value
is ignored.

## Two tiers

- Tier 1 - planner triage. `qwen2.5:1.5b` by default. Sub-second routing
  decision on every input. Returns intent, primary_cli, needed_tools,
  rationale, confidence.
- Tier 2 - reasoning. `gemma4:26b` by default. Used when triage confidence
  is below 0.7, when the sanity layer patched a contradictory decision,
  and for off-hot-path work (intent updates, opinion checks).

Both go through `dashboard/mind/llm.js`. Models can be overridden with
`SYMPHONEE_TRIAGE_MODEL` and `SYMPHONEE_REASONING_MODEL`.

## Sanity layer

After the model returns a decision, a small check enforces consistency:
- If `intent` is `code-question`, `code-action`, `plan`, or
  `browse-files` AND `primary_cli` is missing or `none`, override to
  `claude-code` (the safe default) and knock confidence down to 0.5.
- A force-escalation rule says: if the sanity layer had to patch the
  decision, escalate to gemma even when triage confidence was high.
  The triage confidence is unreliable in exactly those cases.

`greeting`, `recall`, and `ambiguous` intents are allowed to return
`none` -- those legitimately do not need a CLI worker.

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

## Local-first answering

The brain tries to answer questions locally BEFORE dispatching to a
frontier CLI worker. This is the productivity + token-saving faculty.

Pipeline:

  1. classify the input via the planner (qwen + sanity layer + maybe gemma)
  2. if intent is `greeting` -> no-op acknowledgement
  3. if intent needs tools (`code-action`, `plan`, `plugin-call`,
     `apps-action`, `browser-action`) -> escalate, no local attempt
  4. otherwise try Mind recall; if top hit score >= 3.5 and >= 2 hits
     cross the floor, synthesize a short answer via gemma using those
     hits as citations
  5. for pure `recall` / `greeting` / `ambiguous` intents, fall through
     to a local gemma answer (no Mind grounding) as a last attempt
  6. only if all the above fail does the brain say `source: escalate`

When source != escalate, NO frontier CLI is spawned. Zero API tokens
spent. The orchestrator's `/spawn` endpoint integrates this: a call
without a cli now routes through `brain.answer()` and returns the local
answer directly when possible. Pass an explicit cli to bypass.

The thresholds are conservative on purpose - we prefer escalating to a
frontier model over returning a confidently-wrong local answer.

## Workflow synthesis

The brain records every knowledge event into
`.symphonee/sequences.jsonl` (append-only). Idle gaps of 10+ minutes
split sessions. On-demand, the synthesizer clusters recent sessions by
shape similarity (Jaccard on `kind:simplified-path` tokens) and asks
gemma to draft a recipe for any cluster with >=3 occurrences that does
not already have a covering recipe.

Drafts are NOT auto-accepted. The user (or another tool) decides which
to materialize. Accepting a draft writes `recipes/<slug>.md` and never
overwrites an existing file.

This is fully event-driven. Sequences only get recorded when events
flow through `mind.notifyKnowledgeEvent` (save-result, teach,
learnings, file changes the watcher picks up). Nothing runs on a clock.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | /api/symphonee/answer | Local-first answer. Tries Mind, gemma, then escalates. Body: `{ input }`. |
| POST | /api/symphonee/think | Planner front door (decision only, no answer). Body: `{ input }`. |
| GET  | /api/symphonee/decisions | Recent planner decisions (audit log). |
| GET  | /api/symphonee/intent | Current intent state. |
| POST | /api/symphonee/intent/notify | Push an event. |
| POST | /api/symphonee/intent/recompute | Force recompute (uses pending evidence). |
| POST | /api/symphonee/intent/pause | Pause auto-recompute. |
| POST | /api/symphonee/intent/resume | Resume. |
| GET  | /api/symphonee/sequences | Inspect recent recorded sessions. |
| POST | /api/symphonee/synthesize | Draft recipes from observed shapes. |
| POST | /api/symphonee/synthesize/accept | Materialize a draft as recipes/<slug>.md. |
| GET  | /api/symphonee/status | Models + decision count + current intent. |
| GET  | /api/symphonee/instructions | This file. |

## How other CLIs should use it

1. Read `intent.summary` from `bootstrap.brain.intent` when answering the
   user. The intent tells you what the user is *doing*, independent of
   the literal question. Use it to resolve ambiguity.
2. Teach the brain by calling `POST /api/symphonee/intent/notify` with a
   `qa-saved` event after substantive answers. Mostly automatic
   (server-side hooks fire on save-result) but explicit notification is
   allowed.

## Why the brain exists

Before: each CLI re-derives intent from the literal prompt and asks Mind
on its own. Two CLIs answering the same user can route very differently.

After: one Symphonee-owned theory of what the user is doing, used by
every CLI in the session and persisted across sessions.

## Constraint

This system does NOT assume the machine stays on. Intent updates and
planner decisions run only on events (input arrives, file changes,
drawer turn, save-result). Nothing schedules on a clock.
