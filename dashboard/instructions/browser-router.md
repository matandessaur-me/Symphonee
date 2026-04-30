# Browser Router (core, ships with Symphonee)

For browser automation, **call the router instead of picking a driver yourself**. It chooses between three drivers, dispatches the request, and falls back automatically when one isn't reachable.

## Drivers

| Driver | LLM loop? | Browser surface | When to pick |
| --- | --- | --- | --- |
| `browser-use` | no -- typed actions only | the in-app `<webview>` (live, interactable) | The caller already knows the selector / handle / typed action. Cheapest, fastest, no LLM tokens. |
| `in-app-agent` | yes (Symphonee's tool-use loop) | the in-app `<webview>` (live, interactable) | Free-text goal where the user wants to watch live and possibly take over. **Default.** |
| `stagehand` | yes (Stagehand SDK) | a separate headless Chromium streamed to a screencast canvas | Sandboxed/clean profile, schema-driven `extract`, or anything explicitly opted into via `prefer: "stagehand"` / `sandboxed: true` / `mode: "extract"`. |

## Endpoints

All under `/api/browser/router/*`:

- `GET  /status` -- which drivers are reachable, current settings.
- `POST /recommend` -- returns the decision (driver + reason + confidence) without dispatching. Use this when you want to explain the choice to the user before acting.
- `POST /run` -- decide + dispatch. The main entry point.

## Request shape for `/run`

```json
{
  "goal": "log in to GitHub and grab my notification count",
  "url": "https://github.com",
  "mode": "agent",
  "maxSteps": 8,
  "prefer": "auto"
}
```

| field | when to set |
| --- | --- |
| `goal` / `instruction` | free-text task. Routes to in-app-agent by default. |
| `url` | optional pre-navigation. |
| `mode` | Stagehand-only hint: `act` / `extract` / `observe` / `agent`. `extract` forces Stagehand. |
| `maxSteps` | cap on the agent loop. |
| `action` | typed action name (`click_text`, `fill_label`, ...). Forces browser-use. |
| `params` | params for `action`. |
| `selector` | CSS selector. Forces browser-use. |
| `handle` | clickable handle from `/api/plugins/browser-use/clickables`. Forces browser-use. |
| `sandboxed` / `fresh` | `true` -> Stagehand (clean profile, no user cookies). |
| `schema` | a JSON schema for structured extraction -> Stagehand. |
| `prefer` | `"auto"`, `"in-app-agent"`, `"stagehand"`, or `"browser-use"`. Overrides the heuristic. |
| `provider` / `model` | in-app-agent only: pick which AI key drives it. |
| `timeoutMs` | in-app-agent dispatch timeout. Defaults to 600_000. |

## Decision rules (highest priority first)

1. Explicit `prefer` always wins (unless `"auto"`).
2. `action` / `selector` / `handle` -> **browser-use** (deterministic, no LLM).
3. Free-text goal + (`sandboxed` / `fresh` / `schema` / `mode: "extract"`) -> **Stagehand**.
4. Ambiguous short verb-noun goals (for example `click login`) -> **browser-use** by default, or **Stagehand** when `BrowserRouter.preferStagehand` is enabled in Settings.
5. Free-text goal otherwise -> **in-app-agent**.
6. Empty input -> in-app-agent default.

## Visual surface and tab behaviour

- For `in-app-agent` and `browser-use`, the **in-app `<webview>` itself** is the live view. The user can watch and click in real time.
- For `stagehand`, the plugin opens a CDP screencast and renders frames into a canvas overlay on top of the Browser tab. The screencast is read-only -- it's a video, not an interactable browser.
- The router emits `browser-router-dispatch` broadcasts (phase=`start` / `end` / `error`). The dashboard auto-jumps to **Automation -> Browser** on `start` and back to **Terminal** on `end`/`error`. The Automation tab gets a green pulse dot while a run is active.

## Fallback

- `in-app-agent` unreachable -> tries `stagehand` -> falls back to `browser-use`.
- `in-app-agent` returns a page-surface failure -> retries the same free-text goal through `stagehand`. This covers cases where the live internal browser can open the site shell but the agent cannot see or interact with the actual work surface, such as embedded spreadsheets, virtualized grids, canvas-heavy apps, or cross-origin frames.
- `stagehand` not ready, missing its package, missing an API key, or returning 501 -> falls back to `browser-use`.

Each downgrade is recorded in `result.fallbacks[]`.

## Example: free-text goal (live, interactable)

```bash
curl -s -X POST http://127.0.0.1:3800/api/browser/router/run \
  -H 'Content-Type: application/json' \
  -d '{"goal":"go to hacker news, click the top story, summarize the comments","url":"https://news.ycombinator.com/"}'
```

Routes to **in-app-agent**. The user watches the agent in the Browser tab.

## Example: schema-validated extraction (sandboxed)

```bash
curl -s -X POST http://127.0.0.1:3800/api/browser/router/run \
  -H 'Content-Type: application/json' \
  -d '{"goal":"get the price and currency from this product page","url":"https://example.com/p/42","mode":"extract","schema":{"price":"number","currency":"string"}}'
```

Routes to **Stagehand** because `mode: extract` + `schema` are present.

## Example: deterministic typed action (no LLM)

```bash
curl -s -X POST http://127.0.0.1:3800/api/browser/router/run \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","params":{"url":"https://news.ycombinator.com/"}}'
```

Routes to **browser-use** at confidence 0.95 -- sub-second, zero LLM tokens.

## Response shape

```json
{
  "ok": true,
  "driver": "in-app-agent",
  "decision": { "driver": "in-app-agent", "reason": "...", "confidence": 0.85 },
  "fallbacks": [],
  "result": { ... }
}
```
