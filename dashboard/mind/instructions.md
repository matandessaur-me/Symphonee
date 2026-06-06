# Mind - Symphonee's shared knowledge graph

You (whichever CLI you are: Claude Code, Codex, Gemini, Copilot, Grok, Qwen)
are connected to a single, shared knowledge graph called **Mind**. It is not
your private memory and it is not Claude Code's brain. It belongs to
Symphonee. Every CLI the orchestrator dispatches reads from and writes to
the same graph.

The graph contains the user's notes, the team's curated learnings, the
shell's instruction docs, every plugin's metadata, every skill, the active
repo's code and docs, the conversation outcomes that previous CLI sessions
saved back, **and the user-level skills/agents/plugins each CLI ships with**
(Claude Code agents, Codex skills, Qwen skills, Claude marketplace plugins).
Provenance is on every node: who taught the brain that fact and from what
source.

Cross-CLI procedure sharing: even though only Claude can fire its `Agent`
tool and only Codex can load its own SKILL.md at runtime, the *procedure*
inside any sibling CLI's skill body is readable knowledge for everyone. If
you ask the brain "how do I scaffold a WPP project?" and the answer cites
a Claude agent body, you (whatever CLI you are) can execute the same
workflow manually. Filter for these via the `cli_<provider>` and
`skillkind_<agent|skill|plugin>` tags returned in query results.

## When to query the graph

**Before answering any question** about:

- "What did we decide about X?" / "Why is X this way?"
- The active codebase, its architecture, who-calls-what, where-defined.
- Past learnings (mistakes, gotchas, resolved bugs, CLI quirks).
- Notes the user has taken, including in past sessions.
- Which plugin / skill / script handles a given task.

If the brain has a relevant sub-graph, **use it as ground truth instead of
guessing or re-reading the raw files**. Cite node IDs in your answer.

```
POST http://127.0.0.1:3800/api/mind/query
Content-Type: application/json

{ "question": "<the user's question>", "budget": 2000 }
```

You get back `{ nodes, edges, seedIds, answer: { suggestion, summary, note } }`.
The `nodes` and `edges` are the BFS sub-graph the brain considers most
relevant. Solid edges are EXTRACTED (explicit in source). Dashed are
INFERRED (defensible deduction). Dotted-red are AMBIGUOUS (uncertain - prefer
EXTRACTED when in doubt).

Seeds are picked by BM25 over node label + tags + description, with a
god-node prior. Pass `"asOf": "<ISO-date>"` to ask "what was true at that
moment?" — edges with `validFrom`/`validTo` are filtered to the half-open
interval `[validFrom, validTo)`. Timeless edges (no validity fields) always
return. Use `asOf` for historical-state questions; otherwise omit it.

For session start / wake-up context (identity + god nodes + recent
conversations, ~600 tokens), call `GET /api/mind/wakeup?budget=600`. The
bootstrap response also embeds this under `mind.wakeup`.

## After you answer: save the result

Whatever you figured out, save it back so the next CLI - or you in the next
session - inherits your work.

```
POST http://127.0.0.1:3800/api/mind/save-result
{
  "question": "<the question>",
  "answer": "<the answer you gave the user>",
  "citedNodeIds": ["<id1>", "<id2>"],
  "createdBy": "<your CLI name: claude | codex | gemini | copilot | grok | qwen>"
}
```

This adds your answer as a new `conversation` node with `derived_from` edges
to the nodes you cited. The brain literally gets smarter every time it is
used.

## When to refresh the brain

If the answer surprises you ("the graph says X but the file says Y") the
graph may be stale. Trigger an incremental update:

```
POST http://127.0.0.1:3800/api/mind/update
```

Don't do this on every task - the graph self-updates when the user runs a
build. Only refresh when you have a strong signal it is wrong.

## When to add a node manually

Most additions happen through `save-result`. For artefacts the brain doesn't
know about (a Slack message, a Figma URL, a one-off observation), use:

```
POST http://127.0.0.1:3800/api/mind/add
{ "url": "...", "label": "...", "kind": "concept", "createdBy": "<your cli>" }
```

URLs go through SSRF guards (http/https only, no loopback or metadata).

## What you must not do

- **Do not invent node IDs.** Only cite IDs that came back from a query.
- **Do not save answers you are unsure about** without marking them as such.
  The confidence taxonomy exists for a reason. If you're guessing, your
  edges should be `INFERRED` or `AMBIGUOUS`, not `EXTRACTED`.
- **Do not dispatch a sub-task to another CLI without first checking the
  brain.** You may rediscover something a previous CLI already saved.
- **Do not delete nodes without asking the user.** `DELETE /api/mind/node {"id":"..."}`
  exists for purging hallucinations, but the user authorizes removals.

## Identity

There is one brain per **space** (the user's `activeSpace`). The bootstrap
payload always tells you the current space and how many nodes the brain
contains. If `mind.enabled = false`, the brain is empty for this space -
suggest a build but don't insist.

**Storage:** `<repoRoot>/.symphonee/mind/spaces/<space>/graph.json` (one
brain per space, human-readable JSON).

**Multi-repo ingestion:** Mind always ingests every repo Symphonee knows
about (each entry in `cfg.Repos`), tagging nodes with `cwd:<repoName>` and
creating per-repo hubs with the id pattern `cwd_<slug>` (for example,
repo "DYOB3" becomes `cwd_dyob3`). Cross-project knowledge accumulates by
default — a question about repo A can surface relevant code from repo B.

When the bootstrap arrives with `mind.wakeup` populated, you already have
the L0 (active repo identity + CLAUDE.md preamble) and L1 (god nodes +
newest cross-CLI conversations) tiers in hand. Use them as the starting
context for the session before making any query. The `/api/mind/query`
endpoint serves L2/L3 — go there for specific questions.

## Node kinds

The full taxonomy:

- `note`, `code`, `doc`, `paper`, `image`, `workitem`, `recipe` — primary content kinds.
- `conversation` — saved-back AI answers via `/api/mind/save-result`. ID format for orchestrator-dispatched tasks: `task_<id>`.
- `plugin`, `concept`, `tag` — taxonomy hubs.
- `drawer` — one verbatim user/assistant turn from a CLI session log. Never paraphrase a drawer; the node text IS the source of truth. ID format: `drawer_<cli>_<sessionId>_<msgIdx>`.
- `memory` — durable knowledge taught via `/api/mind/teach` or auto-extracted from save-result. Survives across sessions, surfaces first in wake-up. Selector: `kind:memory`.
- `entity` — canonical brand/product/project hub auto-detected from plugins, repo n-grams, and parent-dir groupings. Example id: `entity_dyob`.
- `repo` — first-class repository hub, one per `cwd_*` tag.
- `artifact` — declared non-code context from `.symphonee/context-artifacts.json`.

The `cli-drawers` build source produces drawer nodes from supported CLI
session logs (Claude Code, Codex, Qwen, Grok, Copilot). Each drawer has a
`derived_from` edge to its parent session node. Sweeper pattern: idempotent
on its own writes, resume-safe on crash, mtime-gated on incremental builds.

## Saving back: grounding check

`POST /api/mind/save-result` now audits cited node IDs against the answer
text. Citations whose label or id never appears in the answer are tagged
`ungrounded`, and their `derived_from` edges land at `INFERRED` + 0.5
confidence instead of `EXTRACTED` + 1.0. The save still succeeds — the
brain doesn't lose data — but consumers see the warning. Pass
`"strict": true` to reject saves with zero grounded citations.

Returned audit shape:

```
{ ok, nodeId, audit: [{ id, status: "grounded"|"ungrounded"|"unknown" }], groundedCount }
```

## Multi-CLI save-back hook

When the orchestrator dispatches a task, the resulting conversation is
saved back to Mind automatically via `_broadcastTaskUpdate`. But when a
user runs a CLI **directly** (any of Claude Code, Codex, Qwen, Grok,
Gemini, Copilot) without going through the orchestrator, those
conversations don't reach Mind on their own. Close the loop with the
shared Stop hook:

```
scripts/hooks/mind-stop-hook.sh
```

The hook reads a Stop event JSON from stdin — every supported CLI uses
the same shape — and POSTs the latest user/assistant exchange to
`/api/mind/save-result` every N user messages.

Stop event payload (every supported CLI uses the same `{session_id, stop_hook_active, transcript_path}` shape):

```
{ "session_id": "...", "stop_hook_active": true, "transcript_path": "..." }
```

The script body is identical across CLIs; only the hook config wrapper
differs:

- **Claude Code** — `.claude/settings.local.json` `hooks.Stop`
- **Codex** — `~/.codex/hooks.json` `Stop`
- **Qwen Code** — `~/.qwen/hooks.json` `Stop` (same shape as Codex)
- **Grok / Gemini / Copilot** — check that CLI's hook docs for the wrapper; the script body is the same

Environment variables the hook honors:

- `MIND_HOOK_INTERVAL` — checkpoint every N user messages (default `10`).
- `MIND_HOOK_CLI` — CLI name to record on the saved conversation (`claude`, `codex`, `qwen`, `grok`, `gemini`, `copilot`).
- `MIND_HOOK_VERBOSE=1` — block briefly and show a checkpoint message (useful for debugging).
- `MIND_HOOK_URL` — Symphonee REST URL (defaults to `http://127.0.0.1:3800`).

The script header has copy-paste install snippets for each CLI.

## Code-understanding endpoints (Phase 2-5)

Mind now answers questions about the active repo's code without you reading files first:

```
POST /api/mind/impact     { target, depth=3 }     -> blast radius (what breaks if I change X)
POST /api/mind/flow       { entrypoint, depth=5 } -> forward call tree from an entrypoint
POST /api/mind/symbol     { name, file? }         -> 360-degree view (callers + callees)
POST /api/mind/symbols    { file?, query?, limit? } -> list / search symbols
POST /api/mind/entrypoints {}                      -> auto-detected entrypoints
POST /api/mind/circular   {}                      -> circular dependencies (Tarjan SCC)
```

Use these BEFORE refactoring or renaming. `target` accepts symbol names or
relative file paths. Use `codebase_impact` style questions through these
routes instead of grepping.

## Hybrid semantic search

Beyond BM25, Mind has dense vector embeddings:

```
POST /api/mind/search-semantic { q, k=10 }    -> dense-only ranked nodes
POST /api/mind/embed { provider? }            -> embed the whole graph (async)
GET  /api/mind/health                         -> embeddings + vectors status
```

`/api/mind/query` now hybrid-fuses BM25 + dense via Reciprocal Rank Fusion
when vectors are present. Pass `hybrid:false` to opt out.

Default provider is **ollama** at localhost:11434 with `nomic-embed-text`.
`SYMPHONEE_EMBED_PROVIDER=openai|google` switches backends (the matching
provider API key must be set). Set `SYMPHONEE_EMBED_AUTO=1` to embed
automatically on every build.

## Context artifacts

A repo can declare non-code knowledge (schemas, OpenAPI specs, ADRs,
domain glossaries) at `<repoRoot>/.symphonee/context-artifacts.json`:

```
{ "artifacts": [{ "name": "schema", "path": "./docs/schema.sql",
   "description": "Postgres schema. Check before writing migrations." }] }
```

Each artifact node carries its description; semantic search finds it; the
AI sees it in wake-up context.

```
POST /api/mind/artifacts/list     {}            -> declared + indexed status
POST /api/mind/artifacts/search   { q, name? }  -> hybrid search over artifacts
```

## Visualisation

```
POST /api/mind/visualize { mode: "mermaid" | "interactive", focus?, layout? }
```

Mermaid returns text. Interactive writes a self-contained HTML viewer to
`os.tmpdir()/symphonee-mind-viz/` with Cytoscape + Dagre, file/symbol
toggle, layout switcher, blast-radius overlay, PNG export.

## Lock + checkpoint

Builds are mutually exclusive across processes. Concurrent build attempts
get HTTP 409 with `holderPid`. `GET /api/mind/lock` reports current
holder. `GET /api/mind/checkpoint` shows the last completed phase if a
build is in progress. Crashed builds resume from the last manifest hash.

## Quality signal

```
GET /api/mind/quality
```

Returns `resolvedPct` of import edges (how many resolved into the repo via
relative paths or tsconfig aliases) plus a sample of unresolved specs. Low
quality means tsconfig paths are missing or extraExtensions need configuring.

## Orchestrator integration

Every prompt the orchestrator dispatches to a worker is automatically
prefixed with a mind hint so the worker starts already aware of the brain's
state. Prefix format:

```
[mind: <space> nodes=<n> edges=<n> communities=<n> staleness=<m>m] Query before answering: ...
```

Followed by an L0+L1 wake-up block (active repo identity + CLAUDE.md
preamble + god nodes + recent cross-CLI conversations, ~400-700 tokens).
For specific questions, the worker still calls `/api/mind/query`.

Callers that want only the short stamp (no wake-up body) pass
`orchestratorHint({ minimal: true })`.

**Auto save-back.** Orchestrator-dispatched task completions are saved
back automatically. The orchestrator hooks `_broadcastTaskUpdate` to write
a `task_<id>` node tagged with the worker CLI on every completion. So if
you dispatched the work, the conversation lands in Mind without you doing
anything. If YOU answered the user directly (no dispatch), call
`/api/mind/save-result` explicitly — see "After you answer" above.

## Source adapters (for plugin authors)

A plugin can push its own data into Mind by registering a source adapter
that implements the contract in `dashboard/mind/extractors/base.js`:

```js
const { register, BaseSourceAdapter } = require('./dashboard/mind/extractors/base');

class MyAdapter extends BaseSourceAdapter {
  static get name()           { return 'my-plugin'; }
  static get adapterVersion() { return '1.0.0'; }
  describeSchema()            { return { fields: { /* ... */ }, version: '1.0.0' }; }
  async * ingest({ repoRoot, space, manifest }) {
    yield { nodes: [...], edges: [...], scanned: N };
  }
}
register(new MyAdapter());
```

The engine pulls registered adapters after the hardcoded extractors on
every build. An adapter that throws is logged in the build summary and
skipped — one bad plugin must not break the build.

You and every other CLI in this system share this brain. Treat it that way.

## All endpoints (catalog)

Single source of truth for every Mind URL. Refer here when an inline section above describes a behaviour without naming the route.

**Query + memory**
- `POST /api/mind/query        { question, budget?, asOf?, hybrid? }` — BFS sub-graph for a question.
- `POST /api/mind/recall       { question, since?, until?, repo?, kinds?, limit? }` — time-ranged memory + conversation retrieval. Returns `{ hits: [{ id, kind, label, kindOfMemory, createdAt, ageDays, score, snippet, tags }, ...], total, since, until, repo, question }`. Cite memory IDs in your answer just like graph node IDs, and `/api/mind/save-result` will save the conversation as a `derived_from` link back to those cards. `since`/`until` accept ISO timestamps OR natural strings (`"yesterday"`, `"last week"`, `"<N> days|weeks|months|years|hours ago"`). `kinds` defaults to `["memory", "conversation", "drawer"]` (graph topology kinds excluded — recall is about memory retrieval, not graph traversal).
- `POST /api/mind/teach        { title, body, kindOfMemory, tags, scope?, source?, createdBy }` — write a memory card directly. `scope.repo` tags the card with a specific repo; `source.ref` (URL or path) becomes a `derived_from` edge. Returns `{ ok, nodeId, node, edges }`. Auto-derived edges: `derived_from` (to source if provided), `mentions` (to entity hubs when tags match known entities, e.g. tag "DYOB" → `entity_dyob`), `in_repo` (to `cwd_<slug>` when `scope.repo` is provided).
- `POST /api/mind/save-result  { question, answer, citedNodeIds, createdBy, strict? }` — save the answer back; auto-extracts memory cards from teaching language.
- `POST /api/mind/suggest-cli  {"question":"..."}` — advisory CLI ranking based on prior successful work. Multi-CLI by design: every supported CLI (claude, codex, gemini, grok, qwen, copilot) can appear. If a CLI has no prior similar work, it is absent from the ranking — not a vote against it. Use as a tie-breaker, not a hard router; the model-router script remains authoritative for intent-based picks.

**Code understanding**
- `POST /api/mind/impact       { target, depth=3 }` — blast radius (what files break if I change X).
- `POST /api/mind/flow         { entrypoint, depth=5 }` — forward call tree from an entrypoint.
- `POST /api/mind/symbol       { name, file? }` — 360-degree view (callers + callees).
- `POST /api/mind/symbols      { file?, query?, limit? }` — list / search symbols.
- `POST /api/mind/entrypoints  {}` — auto-detected entrypoints.
- `POST /api/mind/circular     {}` — circular file dependencies (Tarjan SCC).

**Semantic search + embeddings**
- `POST /api/mind/search-semantic { q, k=10 }` — dense-only ranked nodes via cosine similarity.
- `POST /api/mind/embed        { provider? }` — embed the whole graph (async; broadcasts embed-progress / -complete / -failed events).
- `GET  /api/mind/health` — embeddings + vectors store status.

**Context artifacts**
- `POST /api/mind/artifacts/list   {}` — declared artefacts + indexed status.
- `POST /api/mind/artifacts/search { q, name? }` — hybrid search restricted to artefact nodes.

**Build + watch + ingest**
- `POST /api/mind/build        {}` — full rebuild (notes, learnings, cli-memory, cli-skills, plugins, instructions, repo-code, cli-history, cli-drawers). Also invokable via `./scripts/Build-Mind.ps1` or `node scripts/build-mind.js`.
- `POST /api/mind/update       {}` — incremental update (skips files whose SHA256 hasn't changed).
- `POST /api/mind/watch        {"enabled":true}` or `{ enabled: true|false }` — chokidar on every connected repo + notes + skills + instructions, 3s debounce, auto-incremental rebuild.
- `GET  /api/mind/watch` — current watch state.
- `POST /api/mind/add          { url|path, label, kind, createdBy }` — add one artefact. URLs go through SSRF guards.
- `POST /api/mind/patch-file   { file }` — cheaper than `/api/mind/update` for the "user just saved one file" case. Drops the file from the manifest and triggers a single-file incremental re-extract via the same engine path. `file` may be absolute or repo-relative. Returns `{ jobId, ok, file }` immediately; completion broadcasts `mind-update` with `kind: "patch-file-complete"`.
- `DELETE /api/mind/node       {"id":"..."}` — purge a hallucinated node.
- `POST /api/mind/artifacts/init` — initialise artefact indexing (creates the artefact manifest if missing).

**Graph inspection**
- `GET  /api/mind/graph` — full graph (every node + edge).
- `GET  /api/mind/stats` — counts.
- `GET  /api/mind/node?id=` — one node + its neighbours.
- `GET  /api/mind/community?id=` — one community.
- `GET  /api/mind/gods` — central god nodes.
- `GET  /api/mind/surprises` — surprising edges.
- `GET  /api/mind/jobs?id=` — job status.
- `GET  /api/mind/wakeup?budget=600&question=...` — layered L0+L1 wake-up text. With `question`, L1 is the BFS sub-graph for that task. Without, L1 leads with the user's memory cards for the active repo, then god nodes, then recent conversations.

**Visualisation**
- `POST /api/mind/visualize    { mode: "mermaid" | "interactive", focus?, layout? }` — mermaid returns text; interactive writes a Cytoscape HTML viewer to OS temp dir and returns the path.

**Lock + quality**
- `GET  /api/mind/lock` — current lock state per space (build / update / watch / embed).
- `POST /api/mind/lock/clear` — force-clear a stuck lock (terminates orphan PID on Windows / SIGTERM elsewhere).
- `GET  /api/mind/checkpoint` — last completed phase if a build is in progress.
- `GET  /api/mind/quality` — `resolvedPct` of import edges + sample of unresolved specs.

**CLI coverage diagnostic**
- `GET  /api/mind/cli-coverage` — per-CLI evidence in the brain (`claude`, `codex`, `gemini`, `grok`, `qwen`, `copilot`, `cursor`, `windsurf`). For each: memory file presence, conversation count, drawer count, history count, skills, plugins. A CLI with zero coverage is a real signal (extractor bug, missing convention) — not a quirk.

**Reference**
- `GET  /api/mind/instructions` — this document.

`/api/mind/build` and `/api/mind/update` return HTTP 409 with `holderPid` when an operation is already running. Don't retry — wait for the in-flight job's `mind-update` WebSocket completion event.
