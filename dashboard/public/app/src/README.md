# `app.js` source

`dashboard/public/js/app.js` is the dashboard renderer. It is **generated** —
do not edit it by hand. The real source lives here, split into cohesive,
concern-named files under `parts/`, and combined at author time by
`scripts/build-renderer.js`.

```
node scripts/build-renderer.js          # build (also: npm run build:renderer)
node scripts/build-renderer.js --watch  # rebuild on change (npm run watch:renderer)
```

## How it's built: flat concatenation (not ES modules)

The build **concatenates** the files listed in `parts/manifest.json`, in order,
into `js/app.js`. The parts are offset-exact slices of the original file, so the
concatenation is **byte-identical** to the pre-split `app.js` — same single,
flat global scope, zero behavioural change. The build verifies nothing; it can't
break the output because it only joins bytes.

### Why concatenation and not real `import`/`export` modules?

`app.js` is a classic flat-global script: ~875 top-level functions (the 327
inline `onclick=` handlers in `index.html` call them by bare name) and ~146
**mutable** top-level globals (`activeRepo`, `filesCurrentRepo`, `ws`,
`configData`, …) that are reassigned across ~1,700 references in many sections.

In ES modules you cannot reassign an imported binding, so converting to real
modules means rewriting every one of those ~1,700 references to go through a
shared state object (the pattern `mind-ui` uses). That is a large, scope-sensitive
rewrite of a 21k-line UI that has **no automated renderer tests** — precisely the
kind of change that breaks subtly and is not caught by a click-through. So it is
deliberately **not** done as a big bang.

Concatenation gives the win that was actually asked for — navigable, cohesive
source files — with provable safety (byte-identical output).

### Contrast: `mind-ui` *is* real ES modules

`dashboard/public/mind-ui/src/` is split into true `import`/`export` modules
bundled by esbuild. That was safe there because `mind-ui` was already a single
IIFE with a shared **state object** (not flat reassigned globals), so there was
nothing to rewrite. Same goal, different mechanism, chosen by the source's shape.

## The decoupling runway (incremental, when touched)

To evolve `parts/` toward real modules over time, without a risky big bang:

1. Introduce `state.js` exporting one object `S` and move mutable globals onto it
   (`activeRepo` → `S.activeRepo`), one cluster at a time, as you touch a feature.
2. Once a part no longer reassigns any bare global, it can become a real ES
   module (move it to an esbuild bundle entry alongside `mind-ui`).
3. Repeat per file. Each step is small, reviewable, and independently validated.

## Conventions

- One file per domain, named for the domain (`terminals.js`, `git.js`,
  `orchestrator.js`, `work-items.js`, `browser.js`, `apps.js`, `themes.js`,
  `command-palette.js`, …). Order is whatever `manifest.json` says.
- Do not reorder parts arbitrarily: concatenation order is execution order, and
  a handful of top-level statements have load-order dependencies.
- Edit a part, then rebuild. Never hand-edit `js/app.js`.
