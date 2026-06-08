# Dashboard architecture

The `dashboard/` server is the Symphonee backend (HTTP + WebSocket) plus the
Electron shell and the renderer. It is organized **feature-first**: each cohesive
subsystem owns a folder; entry points and standalone one-file services sit at the
root. The former god files were decomposed into cohesive, separately-testable
modules. This map is the entry point for finding where a concern lives.

## Entry points

| File | Role |
|------|------|
| `electron-main.js` | Electron main process: app lifecycle, window, server boot, splash, single-instance lock. ~400 LOC of pure bootstrap. |
| `server.js` | HTTP/WS server bootstrap: static route map, request dispatch, and the `mount*` / `register*` calls that wire every subsystem. |
| `public/index.html` | Renderer markup + a few small bootstrap scripts. Styles and logic are external (below). |

## Module trees (each = one concern)

### `agents/` — the AI automation backends
Two self-contained subsystems, each its own folder so the cluster's internal
`require('./x')` paths stay relative and the whole thing reads as one feature:
- `agents/apps/` — **desktop-app** automation. `apps-agent.js` mounts the routes;
  `apps-agent-chat.js` runs the tool-use loop; the provider/transport/schema/prompt
  layers are split out (`apps-chat-providers`, `apps-chat-http`, `apps-chat-tools`,
  `apps-chat-prompt`, `apps-agent-session`); `apps-driver.js` drives the OS (UIA +
  pixel); plus `apps-memory`, `apps-recipes`, `apps-recorder`, `apps-goal-planner`,
  `apps-learning-loop`, `apps-self-healer`, `apps-frame-diff`, `apps-com`, `apps-sandbox`.
- `agents/browser/` — **in-app browser** automation, same shape: `browser-agent.js`
  (routes), `browser-agent-chat.js` (loop), `browser-chat-{providers,http,telemetry,
  tools,prompts,util}`, `browser-router.js`, `browser-self-healer.js`.

Modules that read runtime data/script dirs (`apps-memory` -> `app-memory/`,
`apps-driver` -> `scripts/*.ps1`) reach them via `__dirname` re-depthed to the
`dashboard/` root, where those shared dirs live.

### `orchestrator/` — cross-AI task orchestration
`orchestrator.js` is a thin class: constructor + instance state only. All behavior
is composed onto the prototype via `Object.assign` from cohesive **mixins** (each
a plain object of methods that run with the instance as `this`):
- `bus.js` — inbox messaging
- `task-store.js` — task CRUD, persistence, serialization, the central update broadcast
- `lifecycle.js` — agent registry, dependency queue, pause/resume, heartbeats, waitFor
- `escalation.js` — escalation, fan-out, aggregation, worktree, lineage, handoff
- `spawn-headless.js` — headless spawn, PTY injection, dispatch
- `spawn-visible.js` — visible PTY spawn with the interactive watcher
- `constants.js`, `state.js` — shared tuning consts + the STATE enum
- `cli-config.js`, `pretrust.js`, `reliability.js`, `routes.js` — config, folder-trust, circuit-breaker/retry, HTTP routes

### `mind/` — the shared knowledge graph
`mind/index.js` is the **controller**: it owns the shared closure helpers
(`persistDerivedGraph`, `notifyKnowledgeEvent`, `refreshEmbedKeys`, `runEmbedSetup`,
`generateInsights`, the watcher + schedulers) and the returned lifecycle hooks
(`bootstrapField`, `saveTaskToMind`, `orchestratorHint`, startup-settle). It builds
one `routeDeps` object and hands it to route modules, each exporting
`register(addRoute, json, deps)`:
- `routes-graph-detail.js`, `routes-graph-reads.js` — node/community/gods/surprises, graph/stats/jobs/quality/anchors
- `routes-code-intel.js` — impact/flow/symbol(s)/entrypoints/circular/files
- `routes-artifacts.js`, `routes-diagnostics.js` — context artifacts; suggest-cli/visualize/cli-coverage
- `routes-knowledge.js` — query/ask/kit/save-result/recall/teach/add/wakeup/instructions
- `routes-insights.js`, `routes-builds.js` — proactive insights; build/update/lock/checkpoint/patch-file

The embed / watch / reflect / heal / startup routes stay in the controller on
purpose: they mutate shared lifecycle state, so separating them would scatter
cohesion rather than improve it. Route modules live in the same dir as `index.js`
so their `require('./x')` paths resolve unchanged.

### `electron/` — Electron main-process concerns
- `browser-dom-helpers.js` — the browser-side DOM helper string injected into the in-app `<webview>` (pure data)
- `webview-driver.js` — `createWebviewDriver({ getWin })` factory: the in-app browser automation driver (navigate/click/fill/CDP debugger)
- `process-guard.js` — `killStaleProcesses(port)` port/instance reclamation
- `ipc-routes.js` — `registerIpcRoutes(addRoute, deps)`: the Electron-only HTTP API (screen switch, update, restart, folder dialog, window controls, browser emulate/issues)

### `lib/` and `routes/` — server kernel
`lib/` holds factories/helpers (`createTerminalHub`, `createUiContextStore`,
`createConfigStore`, `createPluginHints`, `detect-cli`, `notes-ns`, ...).
`routes/` holds `mount*(addRoute, json, deps)` route groups (git, files, notes,
config, spaces, cli-install, image-proxy, plugin-recommendations).

### `public/` — renderer

`index.html` is markup (~2.2k LOC) + a few small bootstrap scripts; `styles/app.css`
holds all styles. The two large scripts — `js/app.js` and `mind-ui.js` — are
**generated build outputs**, authored as small source files and combined at author
time by `scripts/build-renderer.js` (`npm run build:renderer`, or `--watch`). No
runtime build step: the app still serves static files; `index.html` is unchanged.

| Served file | Source | Build strategy |
|------|--------|----------|
| `js/app.js` | `app/src/shell/*.js` + `manifest.json` | **flat concatenation** — byte-identical to the original |
| `mind-ui.js` | `mind-ui/src/*.js` | **esbuild ES-module bundle** |

Two strategies because the two files have different shapes:

- **`mind-ui`** was a single IIFE with a shared **state object**, so it split
  cleanly into real `import`/`export` modules (`core`, `search`, `data`, `graph`,
  `dashboard`, `detailActions`, …) bundled by esbuild. esbuild statically resolves
  every cross-module reference, so a broken link is a build error.
- **`app.js`** is a flat-global classic script: ~875 top-level functions (called
  by 327 inline `on*` handlers by bare name) and ~146 **mutable** globals reassigned
  across ~1,700 references. Real modules would require rewriting all of those to a
  shared state object — a large, scope-sensitive change to an untested 21k-line UI.
  So the shell is split by **concern into cohesive files** under `app/src/shell/`
  (`state.js`, `terminals.js`, `tabs-panels.js`, `startup.js`, `keyboard.js`, ...)
  that **concatenate back byte-identical** — navigable source, zero behavioural
  risk — while feature tabs (`git`, `files`, `work-items`, `browser`, `apps-tab`,
  `themes`, `command-palette`, ...) are extracted as real esbuild modules. The
  incremental path (introduce `state.js`, move mutable globals onto it per cluster,
  then promote a shell file to a module) is documented in `app/src/README.md`.

**Generated files are not hand-edited** — they carry that warning, and the
concatenated `app.js` is provably the original bytes.

## Conventions

- **Route group:** `register(addRoute, json, deps)` / `mount*(addRoute, json, deps)`; build a `deps` object once in the host and pass it in.
- **Class behavior:** mixins via `Object.assign(Class.prototype, require('./x'))` — methods keep `this`; modules export a plain object literal.
- **Factories:** `createX({ ...injected deps })` for stateful helpers (terminal hub, ui-context, webview driver). Late/reassigned values (e.g. the Electron window) are read through a getter, not captured.
- **Shared constants** live in their own module; **tests are co-located** as `<name>.test.js` next to the code.

## Validation

- `node --test --test-force-exit dashboard/**/*.test.js` — co-located unit tests (run with `--test-force-exit`; orchestrator routes start a heartbeat timer).
- Load-check: `node --check dashboard/server.js` for syntax, plus per-module
  require-smoke `ELECTRON=1 node -e "require('./dashboard/<module>')"`. NOTE: do
  **not** require `server.js` itself as a smoke test — it boots the full server
  (mounts everything, starts MCP clients) and does not exit.
- Route-closure wiring (mind): a handler harness invokes every extracted handler against an empty graph to prove each closure symbol is present in `deps` (a load-check can't catch a missing closed-over name — it only fails when the route is called).
- Electron modules: `node` can't load real `electron`, so a mocked-`electron` harness evaluates `electron-main.js` top-to-bottom and exercises the factories; the real boot path is confirmed by a live app restart.
