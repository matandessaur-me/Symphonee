# Browser Use plugin

This plugin layers a few browser-use-style primitives on top of Symphonee's
existing `/api/browser/*` driver. It does NOT replace the driver. It exposes:

1. A typed action registry over the existing browser-agent operations.
2. A "give me the clickable list" endpoint that piggybacks on the
   `enumerateInteractive()` helper added to `browser-agent.js`.
3. A watchdog snapshot endpoint that wraps the driver's popups/about-blank/
   downloads watchdogs.
4. A Mind-aware step recorder that writes a `browser_step` conversation node
   per action so other CLIs can recall what was clicked, when, on which URL.

All routes live under `/api/plugins/browser-use/*`.

## Routes

- `GET  /api/plugins/browser-use/health` - liveness check.
- `GET  /api/plugins/browser-use/actions` - lists the typed action schema for
  the LLM. Each action has `name`, `description`, `params` (JSON Schema-ish).
- `GET  /api/plugins/browser-use/clickables?limit=200&includeHidden=false` -
  inventory of interactive elements on the current page across all accessible
  frames. Mirrors browser-use's clickable list. Each item has `handle`,
  `tag`, `text`, `href`, `role`, `visible`, `occluded`, `pagesAway`.
- `GET  /api/plugins/browser-use/watchdogs` - dialog/aboutblank/download
  events captured since the page launched.
- `POST /api/plugins/browser-use/run-action` - execute one action by name.
  Body: `{ "action": "click_text", "params": { "text": "Sign in" } }`.
  Response: `{ ok, result, savedToMind }`. Each successful run is saved as a
  Mind conversation node so other CLIs see browsing history.
- `POST /api/plugins/browser-use/run-script` - execute an array of actions
  sequentially. Body: `{ "steps": [ { action, params }, ... ] }`. Stops on
  the first failure. Returns the per-step results.

## Actions

| name | params | description |
| --- | --- | --- |
| `navigate` | `{ url }` | Loads a URL. |
| `click_text` | `{ text, exact? }` | Click the best-matching visible element by visible text. |
| `click_handle` | `{ handle }` | Click using a handle from `clickables`. |
| `fill_label` | `{ label, value, exact? }` | Fill the input with the given label. |
| `fill_handle` | `{ handle, value }` | Fill the input identified by handle. |
| `press_key` | `{ key }` | Send a keyboard key (Enter, Tab, Escape...). |
| `wait_for` | `{ selector, timeout? }` | Wait for selector. |
| `screenshot` | `{}` | Capture a viewport screenshot (returns base64). |
| `read_page` | `{ selector? }` | Return cleaned text content. |
| `list_clickables` | `{ limit?, includeHidden? }` | Same as `/clickables` but as an action. |
| `get_watchdogs` | `{}` | Fetch popups/aboutblank/downloads since launch. |

## Mind integration

Every successful action is saved to Mind via
`POST /api/mind/save-result` with `createdBy: "browser-use"`. The question is
the action name + params, the answer is the URL + result snippet. Cited node
IDs are seeded from a `mind/query` over the action description before
execution, so the brain learns *which clickables matter* per page.

## Why not call `/api/browser/*` directly?

You can. This plugin is sugar:

- Schema-validated args, so the LLM gets a clean error before a 500.
- Auto-Mind logging without remembering to call `save-result` afterward.
- A clickable-list endpoint at a stable URL the LLM can find from
  `/api/plugins/instructions` instead of digging through the API reference.

## Source

Patterns ported from https://github.com/browser-use/browser-use (MIT). The
clickable detector heuristics live in `dashboard/browser-agent.js`
(`isInteractive`, `hasJsClickListener`, `enumerateInteractive`). The action
registry is plugin-local at `lib/action-registry.js`.
