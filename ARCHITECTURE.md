# Symphonee Architecture

Symphonee is an Electron desktop app: a Node **server** process and a browser
**renderer**, talking over HTTP/WebSocket on `127.0.0.1:3800`, with a plugin
system layered on top. This document is the map for contributors — where code
lives, how the renderer is built and served, and the exact checklist for
changing either side without breaking the running app.

> Status: this repo is mid-refactor from a few large "god files" toward small,
> encapsulated modules. The boundaries below are the target; some large files
> (`app.js`, `apps-agent*`, `browser-agent*`) are still being decomposed. New
> code should follow the module conventions here, not the legacy shape.

## Top-level layout

```
dashboard/            the app
  server.js           HTTP server + the static-asset ROUTES allow-list + API wiring
  electron-main.js    Electron entry (windows, lifecycle)
  <feature>.js        server-side feature modules (apps-*, browser-*, mcp-server,
                      plugin-loader, graph-runs, learnings, ...)  ← being split
  routes/             extracted HTTP route groups (e.g. image-proxy.js)
  lib/ utils/         shared server helpers
  mind/ brain/        knowledge-graph + reasoning subsystems
  orchestrator/       cross-CLI task bus
  jobs/ skills/ instructions/ tools/   supporting subsystems
  plugins/            installed plugins (each its own git repo) + the plugin SDK
  public/             the RENDERER (browser side) — see below
scripts/              build + dev scripts (build-renderer.js) and *.test.js guards
config/  docs/  recipes/
```

The **server / client boundary is `dashboard/` (Node) vs `dashboard/public/`
(browser)**. Keep it that way: browser code never `require()`s server modules;
the server never imports renderer code. They communicate only over the HTTP/WS
API.

## The renderer (`dashboard/public/`)

The renderer is served as **static files** — there is no runtime bundler. Source
is authored as small files and combined at author-time by
`scripts/build-renderer.js` into the committed files the server serves.

Two build strategies, chosen per file by its shape:

1. **Flat concatenation → `js/app.js`.** The legacy renderer is one flat-global
   script (~875 top-level functions, ~150 mutable globals reassigned across
   ~1700 sites, ~340 inline `onclick=` handlers in `index.html`). Its source
   lives in `public/app/src/parts/*.js`, listed in `parts/manifest.json`, and is
   concatenated **byte-for-byte** into `public/js/app.js`. Same single global
   scope as before the split — provably zero behavior change. See
   `public/app/src/README.md`.

2. **esbuild ES-module bundles → `js/<name>.js` (and `mind-ui.js`).** As leaf
   features are decoupled from the flat scope, they become real
   `import`/`export` modules under `public/<name>/src/`, bundled by esbuild as an
   IIFE. Everything in the bundle is private except what it explicitly attaches
   to `window`. Current bundles: `util` (shared `escapeHtml`), `pinned-tabs`,
   `local-model-prompt`, `mcp`, `notes-search`, `permissions`, and `mind-ui`.

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

## Decoupling runway (how to extract the next part)

Pick a **leaf**: few inbound callers, and — critically — it must not *define* a
top-level `const`/`let` that other parts reference (those are lexical, not on
`window`, so extracting them breaks the other parts). Promote shared helpers to
`util` first (that's why `escapeHtml` moved out of `mcp`).

**The wiring checklist — miss any step and it breaks in the real app:**

1. Move `parts/<name>.js` → `public/<name>/src/index.js`; append `window.<fn> = <fn>`
   for every externally-called function.
2. Remove it from `parts/manifest.json`.
3. Add an esbuild entry in `scripts/build-renderer.js` → `public/js/<name>.js`.
4. Add `<script src="/js/<name>.js">` to `index.html` (before `app.js`, or after
   it if the module touches `state`/DOM at load).
5. **Register `'/js/<name>.js'` in `server.js` `ROUTES`.** The server allow-lists
   static files — an unregistered bundle **404s** and its `window.*` exports
   never define. (This is the bug that broke the permission-mode chip.)
6. Add a per-module `*.test.js` and an `EXTRACTED` row in
   `scripts/build-renderer.test.js`.
7. `node scripts/build-renderer.js` (needs esbuild's platform binary — if the
   build aborts with a missing `@esbuild/...` package, reinstall deps **without**
   `--omit=optional`, with the app closed).
8. `npm test`, then **reload/restart the app and smoke-test the feature.**

Steps 2–6 are enforced by `npm test` (see below). Steps 7–8 are on you.

## Tests (`npm test`)

`npm test` runs the renderer guardrails and per-module unit tests:

- `scripts/build-renderer.test.js` — `app.js` **equals the byte-exact concat** of
  its manifest parts (no drift / no forgotten rebuild); manifest↔parts
  integrity; and the extraction contract for each module (gone from `app.js`,
  exposed on `window`, **registered in `server.js`**).
- `scripts/served-assets.test.js` — **every local asset `index.html` loads is
  served by `server.js`.** This catches the "added a script, forgot the route"
  class generically, for any asset.
- `public/<name>/<name>.test.js` — runs each built module in a Node `vm` with
  stubbed browser globals, proving it is self-contained and its API behaves.

These are static/vm tests — they cannot catch live load-order or DOM issues, so
the real-app smoke-test (checklist step 8) is not optional.

## Server side

`server.js` owns the HTTP server, the static `ROUTES` allow-list, and wires API
routes (many already extracted under `routes/`). Large feature files
(`apps-agent*`, `browser-agent*`, `apps-driver`, `mcp-server`, `plugin-loader`,
`graph-runs`) are being decomposed into cohesive modules/subdirectories the same
way — small files, explicit exports, no shared mutable god-state. When you split
one, keep public function names stable (or update all call sites) and add unit
tests next to the module.

## Plugins

Plugins live in `dashboard/plugins/<id>/` (each its own git repo) and expose
routes under `/api/plugins/<id>/*`. Iframe-based plugin tabs load the SDK at
`plugins/sdk/symphonee-sdk.js` and talk to the host via `postMessage` using the
`__symphonee` envelope. The host bridge is in the renderer's `plugins` part.
