# Dashboard architecture

The `dashboard/` server is the Symphonee backend (HTTP + WebSocket) plus the
Electron shell and the renderer. It was modularized from a handful of very large
files into cohesive, separately-testable modules. This map is the entry point for
finding where a concern lives.

## Entry points

| File | Role |
|------|------|
| `electron-main.js` | Electron main process: app lifecycle, window, server boot, splash, single-instance lock. ~400 LOC of pure bootstrap. |
| `server.js` | HTTP/WS server bootstrap: static route map, request dispatch, and the `mount*` / `register*` calls that wire every subsystem. |
| `public/index.html` | Renderer markup + a few small bootstrap scripts. Styles and logic are external (below). |

## Module trees (each = one concern)

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
- `index.html` — markup (~2.2k LOC)
- `styles/app.css` — all styles (extracted from the inline `<style>`)
- `js/app.js` — the main renderer logic (extracted from the inline `<script>`)
- `mind-ui.js` — the Mind UI

`app.js` and `mind-ui.js` are still single files. Splitting them further safely
requires a build step (e.g. esbuild + ES modules) because they share one global
scope and rely on per-script function hoisting — a plain multi-file split would
break at runtime in ways only visible in the live GUI. That is a deliberate future
pass, not a blind edit.

## Conventions

- **Route group:** `register(addRoute, json, deps)` / `mount*(addRoute, json, deps)`; build a `deps` object once in the host and pass it in.
- **Class behavior:** mixins via `Object.assign(Class.prototype, require('./x'))` — methods keep `this`; modules export a plain object literal.
- **Factories:** `createX({ ...injected deps })` for stateful helpers (terminal hub, ui-context, webview driver). Late/reassigned values (e.g. the Electron window) are read through a getter, not captured.
- **Shared constants** live in their own module; **tests are co-located** as `<name>.test.js` next to the code.

## Validation

- `node --test --test-force-exit dashboard/**/*.test.js` — co-located unit tests (run with `--test-force-exit`; orchestrator routes start a heartbeat timer).
- Load-check: `ELECTRON=1 node -e "require('./dashboard/server.js'); console.log('LOAD_OK')"` mounts everything without binding a port.
- Route-closure wiring (mind): a handler harness invokes every extracted handler against an empty graph to prove each closure symbol is present in `deps` (a load-check can't catch a missing closed-over name — it only fails when the route is called).
- Electron modules: `node` can't load real `electron`, so a mocked-`electron` harness evaluates `electron-main.js` top-to-bottom and exercises the factories; the real boot path is confirmed by a live app restart.
