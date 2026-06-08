# `app.js` source (the renderer shell)

`dashboard/public/js/app.js` is the dashboard renderer **shell**. It is
**generated** — do not edit it by hand. The real source lives here, split into
cohesive, concern-named files under `shell/`, and combined at author time by
`scripts/build-renderer.js`.

```
node scripts/build-renderer.js          # build (also: npm run build:renderer)
node scripts/build-renderer.js --watch  # rebuild on change (npm run watch:renderer)
```

`app.js` started as a single ~25k-line god file. Most of it has been carved out
into real esbuild ES-module bundles (`git`, `files`, `work-items`, `browser`,
`apps-tab`, `themes`, `command-palette`, `settings`, ... ~23 in all — see
`ARCHITECTURE.md`). What remains here is the **residual shell**: the flat-global
core that the modules build on — `state.js`, `terminals.js`, `app-state.js`,
`startup.js`, `tabs-panels.js`, `onboarding.js`, `keyboard.js`.

## How it's built: flat concatenation (not ES modules)

The build **concatenates** the files listed in `shell/manifest.json`, in order,
into `js/app.js`. The shell files are offset-exact slices of the original file,
so the concatenation is **byte-identical** to the pre-split `app.js` — same
single, flat global scope, zero behavioural change.

### Why concatenation and not real `import`/`export` modules?

The shell is classic flat-global script: top-level functions (called by inline
`onclick=` handlers in `index.html` by bare name) and **mutable** top-level
globals (`activeRepo`, `ws`, `configData`, ...) reassigned across many sites.
In ES modules you cannot reassign an imported binding, so converting the shell to
real modules means routing every one of those reassignments through a shared
state object. That is a scope-sensitive rewrite of UI with **no automated DOM
tests** — precisely the kind of change that breaks subtly. So the shell is
deliberately kept as a byte-identical concatenation: navigable, cohesive source
with provable safety.

### Contrast: extracted features and `mind-ui` *are* real ES modules

`public/<feature>/src/` and `public/mind-ui/src/` are true `import`/`export`
modules bundled by esbuild. Extraction is safe once a feature no longer reassigns
bare shell globals (it talks to the shell through `window.*`). Same goal,
different mechanism, chosen by the source's shape.

## The decoupling runway (incremental, when touched)

To shrink the shell toward real modules over time, without a risky big bang:

1. Introduce/extend `state.js` and move mutable globals onto one object, one
   cluster at a time, as you touch a feature.
2. Once a shell file no longer reassigns any bare global, promote it to an esbuild
   bundle entry (see the checklist in `ARCHITECTURE.md`).
3. Repeat per file. Each step is small, reviewable, and independently validated by
   `npm run test:renderer`.

## Conventions

- One file per concern, named for the concern. Order is whatever `manifest.json`
  says — do not reorder arbitrarily: concatenation order is execution order, and a
  handful of top-level statements have load-order dependencies.
- Edit a shell file, then rebuild. Never hand-edit `js/app.js`.
