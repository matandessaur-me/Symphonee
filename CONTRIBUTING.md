# Contributing to Symphonee

Thanks for helping build Symphonee. This guide covers the dev loop, the repo's
conventions, and the rules that keep the app from breaking in ways the unit
tests can't see. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first — it's the map.

## Prerequisites

- **Node.js 18+** and **npm**.
- Windows is the primary target (the desktop-automation and PowerShell script
  layers are Windows-specific); the core server/renderer run cross-platform.

## Setup & run

```bash
npm install            # do NOT pass --omit=optional: esbuild needs its platform binary
npm start              # the Node server (http://127.0.0.1:3800)
npm run electron       # the desktop app
```

## The renderer is generated — edit the source, not the output

`dashboard/public/js/app.js` and `dashboard/public/js/<module>.js` are **built
files**. Never hand-edit them. Edit the source and rebuild:

```bash
npm run build:renderer       # build once
npm run watch:renderer       # rebuild on change
```

- Flat-script source: `dashboard/public/app/src/parts/*.js` (concatenated).
- Module source: `dashboard/public/<name>/src/` (esbuild bundles).

If `build:renderer` fails with a missing `@esbuild/<platform>` package, your
install dropped esbuild's optional binary — reinstall **without**
`--omit=optional` (close the app first; it locks `node_modules`).

## Tests

```bash
npm test
```

Runs the renderer guardrails + per-module unit tests. **Add a test with every
change** — a per-module `*.test.js` for new renderer modules, a unit test next
to any server module you extract.

Two guardrails are load-bearing and must stay green:

- **`app.js` must equal the byte-exact concatenation of its parts** (you forgot
  to rebuild, or hand-edited the output).
- **Every local asset `index.html` loads must be registered in `server.js`**
  (the server allow-lists static files; an unregistered bundle 404s silently).

The unit tests run in Node with stubbed browser globals — they can't catch live
load-order/DOM problems, so **always reload/restart the app and exercise the
feature you touched** before opening a PR.

## Extracting renderer code into a module

This is the most common refactor and the easiest to get subtly wrong. Follow the
**wiring checklist in [`ARCHITECTURE.md`](./ARCHITECTURE.md#decoupling-runway-how-to-extract-the-next-part)**
exactly — all eight steps, including registering the bundle in `server.js`
`ROUTES`. `npm test` enforces most of them; the real-app smoke-test is on you.

## Branches & commits

- Branch from the current integration branch (or `master` for standalone fixes);
  use `feature/…`, `fix/…`, `refactor/…`, or `restructure/…` names.
- **Don't push to `master`.** Larger efforts land on an integration branch and
  merge to `master` only once the whole thing is verified.
- Conventional-commit style: `type(scope): summary` (e.g.
  `refactor(renderer): extract permissions as ES module`). Explain the *why* in
  the body, especially for refactors.
- Show the diff and get it reviewed before committing; never bundle unrelated
  changes.

## Code style

- Match the surrounding code — naming, comment density, idioms.
- Plain ASCII in source and docs (no smart quotes, em-dashes, or emoji).
- No new "god files": prefer small, single-responsibility modules with explicit
  exports over adding to a large shared scope.
