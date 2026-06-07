---
name: Verify a frontend edit
description: How to safely edit and validate Symphonee's dashboard renderer. The served js/app.js and mind-ui.js are GENERATED build outputs -- edit the source under dashboard/public/app/src/parts/ or mind-ui/src/, rebuild, then validate.
when: editing the dashboard renderer (app/src/parts/*.js, mind-ui/src/*.js, dashboard/public/index.html, or styles/app.css)
tags: frontend, verification, quality, build
---

# Verify a frontend edit

The dashboard renderer is BUILT from source. The two big served files are
generated -- never hand-edit them; your change is wiped on the next build.

## The renderer layout (post-refactor)
- `dashboard/public/index.html` -- markup + a few SMALL bootstrap inline `<script>`
  blocks (localStorage migration, theme pre-apply, panel-state, boot overlay). The
  main logic is NOT inline anymore.
- `dashboard/public/styles/app.css` -- all styles.
- `dashboard/public/js/app.js` -- GENERATED. Source = `app/src/parts/*.js` (cohesive
  concern files: terminals, files, git, orchestrator, notes, work-items, browser,
  apps, themes, command-palette, ...) concatenated per `app/src/parts/manifest.json`.
  Flat single global scope; 327 inline `on*` handlers call its functions by bare name.
- `dashboard/public/mind-ui.js` -- GENERATED. Source = `mind-ui/src/*.js`, REAL ES
  modules (import/export) bundled by esbuild.
- Build: `npm run build:renderer` (or `node scripts/build-renderer.js`; `--watch` for dev).

## Use when
- Editing any renderer source (`app/src/parts/*`, `mind-ui/src/*`), the small inline
  scripts in `index.html`, or `styles/app.css`.

## Steps (primary path)
1. Edit the SOURCE, never the generated output. Renderer logic -> the right
   `app/src/parts/<concern>.js` or `mind-ui/src/<module>.js`. If you cannot find the
   function, grep the parts/modules. Do NOT edit `js/app.js` or `mind-ui.js` directly.
2. Rebuild: `npm run build:renderer`. For `mind-ui`, a clean esbuild build PROVES the
   cross-module wiring (a missing import is a build error). For `app.js`, the build
   concatenates the parts.
3. Syntax-check: `node --check` the edited source file AND the built output
   (`node --check dashboard/public/js/app.js` / `mind-ui.js`).
4. Scope rules:
   - `app.js` parts share ONE flat global scope (concatenation). Top-level `function`
     declarations are global (and reachable by inline handlers); top-level `let`/`const`
     are shared across parts but are NOT `window` properties -- an inline `onclick`
     must call a FUNCTION, not read a bare `let`.
   - `mind-ui` modules are isolated ES modules: a symbol used across files must be
     `export`ed and `import`ed. Shared mutable state lives on the single exported
     `state` object (never reassign an imported binding).
5. If you edited `index.html`'s inline `<script>` blocks: `node --check` can't read
   HTML, so extract each block and run it through `new vm.Script(code)`.
6. Live-validate: reload the app (Ctrl+R; hard-reload if cached) and exercise the
   touched UI. GUI-only breakage is the real risk -- automated checks can't see it.
7. Then proceed to `ship-a-change` (show the diff as its own step, etc.). Commit BOTH
   the source and the rebuilt output.

## Safety
- NEVER hand-edit `dashboard/public/js/app.js` or `dashboard/public/mind-ui.js` --
  they are generated; edit source + rebuild.
- A clean build + `node --check` is necessary but not sufficient: only a live reload
  catches runtime/GUI breakage.

## Verification
- The edited source built cleanly (`npm run build:renderer` with no error).
- `node --check` passes on the source and the built output.
- The change was exercised live in the running app.
