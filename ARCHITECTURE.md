# Symphonee Architecture

Symphonee is an Electron desktop app: a Node **server** process and a browser
**renderer**, talking over HTTP/WebSocket on `127.0.0.1:3800`, with a plugin
system layered on top. This document is the map for contributors and AI agents —
where code lives, how the renderer is built and served, and the exact checklist
for changing either side without breaking the running app.

> The codebase is organized **feature-first**: each cohesive subsystem owns a
> folder; cross-cutting entry points and standalone services sit at the
> `dashboard/` root. The former "god files" (a 25k-line renderer `app.js`, the
> apps/browser automation backends, `plugin-loader`, `graph-runs`, `learnings`,
> `server.js`) have been decomposed into small, separately-testable modules with
> explicit exports and no shared mutable god-state.

## Top-level repo layout

```
dashboard/    the app (server + renderer + all subsystems) — see below
scripts/      build + dev scripts (build-renderer.js) and *.test.js renderer guards;
              also the AI-facing PowerShell helpers (Show-Diff.ps1, Add-Repo.ps1, ...)
skills/       procedural skills (model-neutral "how we do X" — SKILL.md per skill)
recipes/      example recipe docs
config/       runtime configuration (gitignored secrets)
INSTRUCTIONS.base.md   the single source of truth for the per-CLI instruction files
              (CLAUDE.md / AGENTS.md / GEMINI.md / GROK.md / QWEN.md / copilot —
              all GENERATED + gitignored; never edit them directly)
ARCHITECTURE.md  this file        CONTRIBUTING.md  contributor rules
```

## `dashboard/` layout (feature-first)

```
dashboard/
  server.js          HTTP/WS server: the static-asset ROUTES allow-list + all mount*() wiring
  electron-main.js   Electron entry (windows, lifecycle, server boot)   } entry points,
  startup-trace.js   boot timing                                         } stay at root
  request-firewall.js  Origin/Host gate (anti-CSRF / anti-DNS-rebind)

  agents/            the AI automation subsystems
    apps/            desktop-app automation backend (apps-agent, apps-chat-*, apps-driver,
                     apps-memory, apps-recipes, apps-recorder, apps-self-healer, ...)
    browser/         in-app browser automation backend (browser-agent, browser-chat-*,
                     browser-router, browser-self-healer)
  mind/   brain/     shared knowledge graph + reasoning (the "brain")
  orchestrator/      cross-CLI task bus (mixins onto orchestrator.js)
  mcp/               MCP server (stdio) + MCP client manager
  plugins-core/      the plugin loader + manifest rules   (plugins/ = installed instances)
  graph/             durable multi-step graph-run engine + pure helpers
  learnings/         shared-learnings store + the redaction/scrub layer
  routes/            mount*(addRoute, json, deps) HTTP route groups (git, files, notes, ...)
  lib/  utils/       shared server helpers + factories (terminal hub, ui-context, ...)
  instructions/      the /api/instructions/* markdown corpus
  jobs/ skills/ tools/   supporting subsystems
  plugins/           installed plugins (each its own git repo) + the plugin SDK
  public/            the RENDERER (browser side) — see below

  <standalone services at root>: contracts, hybrid-search, instruction-audit,
    jobs-scheduler, model-router, permissions, repo-map, run-recipe, site-recipes,
    skill-corpus, skill-reflection  (one-file services; a one-file folder would be noise)
  <runtime data dirs at root>: app-memory/, app-recipes/, site-recipes/, ...  (read by
    both agents/ and mind/ — kept at root so those shared paths stay valid)
```

The **server / client boundary is `dashboard/` (Node) vs `dashboard/public/`
(browser)**. Keep it that way: browser code never `require()`s server modules;
the server never imports renderer code. They communicate only over the HTTP/WS
API. **Routes are stable** — moving a module's *file* never changes its
`/api/...` endpoint, so the contract AI agents rely on is unaffected by code
reorganization.

## The renderer (`dashboard/public/`)

The renderer is served as **static files** — there is no runtime bundler. Source
is authored as small files and combined at author-time by
`scripts/build-renderer.js` into the committed files the server serves.

Two build strategies, chosen per file by its shape:

1. **Flat concatenation → `js/app.js`.** The renderer **shell** (the legacy
   flat-global core: state, terminals, tabs, startup, keyboard) is authored as
   concern-named files under `public/app/src/shell/*.js`, listed in
   `shell/manifest.json`, and concatenated **byte-for-byte** into
   `public/js/app.js`. Same single global scope as the original — provably zero
   behavior change. See `public/app/src/README.md`.

2. **esbuild ES-module bundles → `js/<name>.js`.** Each leaf feature decoupled
   from the flat scope is a real `import`/`export` module under
   `public/<name>/src/`, bundled by esbuild as an IIFE — private except what it
   attaches to `window`. ~23 bundles, e.g.: `util`, `pinned-tabs`,
   `local-model-prompt`, `mcp`, `themes`, `notifications`, `git`, `files`,
   `notes`, `notes-search`, `pull-requests`, `work-items`, `spaces-repos`,
   `command-palette`, `plugins`, `plugin-registry`, `permissions`, `settings`,
   `orchestrator`, `browser`, **`apps-tab`** (the Apps tab — renamed from the old
   `apps.js` so it is never confused with `app.js`, the shell), plus `mind-ui`.

### How an extracted module talks to the still-flat `app.js`

`app.js` is a classic (non-module) script, so its top-level `function`/`var`
declarations are properties of `window`. That means:

- A module can call any `app.js` global by bare name (it resolves to `window.x`)
  **at runtime**.
- A module's own functions are private to its IIFE. Any function that `app.js`
  or an inline `onclick` calls **must be re-attached to `window`** at the bottom
  of the module (`window.foo = foo`).
- **Load order matters.** A module that only *defines* functions can load before
  `app.js`. A module that reads/writes the shared global `state` **at load time**
  must load **after** `app.js` (which declares `var state`). `index.html`
  encodes this — pre-`app.js` bundles vs. the post-`app.js` block.

## Extracting the next renderer feature — the wiring checklist

Pick a **leaf**: few inbound callers, and it must not *define* a top-level
`const`/`let` that other shell files reference (those are lexical, not on
`window`). Promote shared helpers to `util` first.

1. Move `shell/<name>.js` → `public/<name>/src/index.js`; append `window.<fn> = <fn>`
   for every externally-called function.
2. Remove it from `shell/manifest.json`.
3. Add an esbuild entry in `scripts/build-renderer.js` → `public/js/<name>.js`.
4. Add `<script src="/js/<name>.js">` to `index.html` (before `app.js`, or after
   it if the module touches `state`/DOM at load).
5. **Register `'/js/<name>.js'` in `server.js` `ROUTES`.** The server allow-lists
   static files — an unregistered bundle **404s** and its `window.*` exports
   never define.
6. Add a per-module `*.test.js` and an `EXTRACTED` row in
   `scripts/build-renderer.test.js`.
7. `node scripts/build-renderer.js` (needs esbuild's platform binary — if the
   build aborts with a missing `@esbuild/...` package, reinstall deps **without**
   `--omit=optional`, with the app closed).
8. `npm test`, then **reload/restart the app and smoke-test the feature.**

Steps 2-6 are enforced by `npm test`. Steps 7-8 are on you.

## Tests

- `npm run test:renderer` — renderer guardrails + per-module unit tests:
  - `scripts/build-renderer.test.js` — `app.js` **equals the byte-exact concat** of
    its manifest shell modules (no drift); manifest<->shell integrity; and the
    extraction contract per module (gone from `app.js`, exposed on `window`,
    **registered in `server.js`**).
  - `scripts/served-assets.test.js` — **every local asset `index.html` loads is
    served by `server.js`** (catches "added a script, forgot the route").
  - `public/<name>/<name>.test.js` — each built module run in a Node `vm` with
    stubbed browser globals.
- `npm run test:server` — co-located backend unit tests (agents adapters,
  graph-run helpers, plugin-manifest rules, learnings redaction, request firewall,
  mind, brain, routes, ...).

These are static/vm tests — they cannot catch live load-order, runtime
`__dirname` data-paths, or DOM issues, so the real-app smoke-test is not optional.

## Server side

`server.js` owns the HTTP server, the static `ROUTES` allow-list, and the
`mount*()` calls that wire every subsystem. Each feature subsystem lives in its
own folder (`agents/apps`, `agents/browser`, `mcp`, `graph`, `learnings`,
`plugins-core`, `mind`, `orchestrator`) as small files with explicit exports;
HTTP route groups live under `routes/`. When you split a file, keep public
function names stable (or update all call sites) and add unit tests next to the
module. Files that read data/script dirs via `__dirname` must keep that path
valid when moved (the data dirs live at the `dashboard/` root).

## Plugins

Plugins live in `dashboard/plugins/<id>/` (each its own git repo) and expose
routes under `/api/plugins/<id>/*`. The loader/validation rules are in
`plugins-core/` (`plugin-loader.js`, `plugin-manifest.js`). Iframe-based plugin
tabs load the SDK at `plugins/sdk/symphonee-sdk.js` and talk to the host via
`postMessage` using the `__symphonee` envelope. The host bridge is the renderer's
`plugins` module.

## Instructions & the brain (for AI agents)

Symphonee teaches every CLI how to work through **routes, not file paths**, so
the reorganization leaves the agent contract intact:

- `GET /api/bootstrap` returns everything a CLI needs at session start (context,
  instructions, plugins, learnings, permissions, mind state, skills, audit).
- `/api/instructions/*` serves the instruction corpus (shell rules, permissions,
  scripts, orchestrator, model-router, graph-runs, apps/browser automation).
- `INSTRUCTIONS.base.md` is the single source; the per-CLI files are generated.
- The **Mind** knowledge graph (`/api/mind/*`) indexes the code; after a large
  refactor, rebuild it (`Build-Mind.ps1`) so its node paths track the new layout.
