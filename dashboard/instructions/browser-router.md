# Browser Router (core, ships with Symphonee)

For browser automation, **call the router instead of picking a driver yourself**. It chooses between Stagehand (natural-language, DOM-resilient) and the in-app browser-use driver (typed actions, recipes, in-app webview), dispatches the request, and falls back automatically when one driver is unavailable.

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
| `goal` / `instruction` | free-text task. Routes to Stagehand. |
| `url` | optional pre-navigation. |
| `mode` | Stagehand-only: `act` (default), `extract`, `observe`, `agent`. |
| `maxSteps` | cap on the Stagehand agent loop. |
| `action` | typed action name (`click_text`, `fill_label`, ...). Forces browser-use. |
| `params` | params for `action`. |
| `selector` | CSS selector. Forces browser-use. |
| `handle` | clickable handle from `/api/plugins/browser-use/clickables`. Forces browser-use. |
| `prefer` | `"auto"`, `"stagehand"`, or `"browser-use"`. Overrides the heuristic. |

## Decision rules (highest priority first)

1. Explicit `prefer` always wins (unless `"auto"`).
2. If `action`, `selector`, `handle`, or `recipeId` is supplied, the request is already a deterministic recipe step -- the router picks **browser-use** (no LLM needed).
3. Free-text `goal` / `instruction` with no selector -> **Stagehand**.
4. Empty input -> falls back to the configured default (Stagehand by default).

## Visual surface

When Stagehand handles a request, the plugin auto-starts a CDP screencast on the first primitive call. Frames are broadcast as `stagehand-screencast` events on the dashboard websocket and rendered on a canvas overlay inside the existing **Browser** tab. The user sees the same tab whether browser-use (in-app webview) or Stagehand (overlay) is driving.

The overlay auto-hides 8 seconds after the last frame. To stop earlier, call `POST /api/plugins/stagehand/screencast/stop` or click "Close" on the overlay.

## Fallback

If the router picks `stagehand` but the plugin is not installed or the package is missing, it retries against browser-use and reports the downgrade in `fallbacks[]`. Callers don't need to handle this -- just check `result.ok`.

## Example: one call replaces "should I use Stagehand or browser-use?"

```bash
curl -s -X POST http://127.0.0.1:3800/api/browser/router/run \
  -H 'Content-Type: application/json' \
  -d '{"goal":"go to hacker news, click the top story, summarize the comments","mode":"agent","maxSteps":6}'
```

Response: `{ ok, driver, decision: { reason, confidence }, fallbacks, result }`.
