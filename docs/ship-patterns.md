# DevOps Pilot Ship Patterns

Conventions for shipping new features to DevOps Pilot. These reduce the blast radius of big changes and let us merge early without committing the whole app to an unstable code path.

## BETA feature-flag pattern

Every new feature with real complexity or a non-trivial failure mode ships behind a `config.json` feature flag, default OFF. Same shape as `OrchestrateMode` and `IncognitoMode`.

### Schema

Add a top-level boolean to `config/config.template.json`:

```json
"GraphRunsMode": false
```

Naming: `<Feature>Mode` matches the existing house style.

### UI

Add a toggle to **Settings -> Other** with a BETA badge and a clear one-line description:

```html
<label class="beta-toggle">
  <input type="checkbox" id="settingsGraphRunsMode"> Graph Runs
  <span class="beta-badge">BETA</span>
  <div class="toggle-desc">Durable multi-step workflows with checkpointing. One-shot spawns are unaffected. Off by default while this stabilizes.</div>
</label>
```

### Server behavior when OFF

- Feature endpoints return `501 Not Implemented` with a JSON body explaining the flag to enable.
- Feature UI surfaces (tabs, panels, buttons) are hidden via `body.feature-X-off { display: none }` class toggles, same as incognito.
- Zero background work. Zero file creation. Zero perf impact on users who have it off.
- The `INSTRUCTIONS.base.md` block for the feature is stripped from generated `CLAUDE.md`, `AGENTS.md`, etc. via `<!-- FEATURE_X_START -->` / `<!-- FEATURE_X_END -->` marker pairs processed in `writePluginHints()`.

### Server behavior when ON

- Full API surface live.
- UI surfaces appear.
- Background resources (SQLite files, indexes, watchers) initialize lazily on first use, not at boot.

### Promotion path

1. Ship the feature BETA-gated, default OFF, merged to master.
2. Dogfood it for 1-2 weeks on real work.
3. Follow-up PR flips the default to `true` and drops the BETA badge.
4. Keep the toggle around for at least another release so users can opt out if regression.
5. Eventually remove the toggle; feature becomes part of the baseline.

## Which features ship BETA-gated vs. on-by-default

**BETA-gated** (complex, new data paths, background resources, durable state):
- Graph runs
- Shadow-git checkpoints
- Prompt registry with regression evals
- ADO temporal knowledge graph
- Hybrid BM25 + vector search
- Verbatim session capture

**On by default** (additive, low-risk, no new background work):
- Recipes (markdown loader only)
- Query sanitizer (string filter)
- Layered context wake-up (prompt preamble restructuring)
- Hooks (lifecycle callbacks, no-op when no plugin registers)
- Repo map (cache-only)

## Why this pattern

- Lets us merge complex features to master early instead of growing long-lived branches that rot.
- Gathers feedback from opt-in users before forcing a new code path on everyone.
- Bugs in a feature-flagged path affect only users who opted in.
- Matches `OrchestrateMode` and `IncognitoMode`, already proven in this codebase.
- Matches the open-source norm (LaunchDarkly / Unleash / GitHub feature flags) that the broader industry has adopted.

## Implementation checklist for a new BETA feature

- [ ] Add `<Feature>Mode: false` to `config/config.template.json`.
- [ ] Add toggle + BETA badge to Settings -> Other.
- [ ] Gate all new endpoints with `cfg.<Feature>Mode === true` or return 501.
- [ ] Gate all new UI surfaces with a `body.<feature>-off` class toggle in `loadConfig`.
- [ ] Wrap feature-specific instructions in `INSTRUCTIONS.base.md` with a `<!-- FEATURE_X_START -->` marker pair.
- [ ] Add stripping logic in `writePluginHints()` alongside the existing orchestration / incognito strippers.
- [ ] Confirm zero work happens on boot when the flag is off (grep for top-level `require` side-effects).
- [ ] Update `README.md` with a short BETA section under Features.
- [ ] In the PR description, link to this doc and mention the promotion path.
