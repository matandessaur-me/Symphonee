# Stagehand plugin

Layered on top of `browser-use`, NOT a replacement. Use this when you want
natural-language browser actions and resilience to DOM changes; use
`browser-use` when you have typed actions and a known page structure.

## Local-only by design

The session is hard-locked to `env: "LOCAL"`. There is no setting and no
route that can route a request through Browserbase cloud. The only network
calls go to:
- Whatever LLM provider the configured model uses (your API key, your bill).
- The local Chrome DevTools Protocol over WebSocket (your machine).

## Install

```
npm install @browserbasehq/stagehand chrome-launcher
```

Optional (Stagehand will pick whichever is present):
```
npm install playwright-core
```

## Routes (all under /api/plugins/stagehand/)

- `GET  /health` - readiness + env confirmation. Always reports
  `cloudReachable: false`.
- `POST /goto` - `{ url }` - navigate the current page.
- `POST /act` - `{ instruction, url? }` - run one natural-language action.
  Self-heals across DOM changes; resolved selectors are cached, so repeats
  cost ~0 LLM tokens.
- `POST /extract` - `{ instruction }` - extract structured data from the
  current page using a natural-language description.
- `POST /observe` - `{ instruction }` - inspect the page and return a list
  of candidate actions/elements without performing them.
- `POST /agent` - `{ task, maxSteps? }` - multi-step planner-actor loop.
  Use sparingly: each step is an LLM call.
- `POST /close` - tear down the session and the Chrome process.

## When to use which primitive

- `act` - "click the sign-in button", "fill the search box with 'ramen'".
  Resilient to text/structure changes.
- `extract` - "get the price and currency from the product page".
- `observe` - "what are the clickable items on this page?". Free-form
  reconnaissance, no side effects.
- `agent` - "log in, search for X, add the first result to cart". Multi-step
  loop. Expensive, use only when scripted steps don't fit.

## When to prefer browser-use instead

- You already know the exact selector or the visible text is stable.
- You're running the same recipe many times and want zero LLM cost.
- You need the existing watchdogs (popups/dialogs/downloads) and the
  in-app `<webview>` to render the page for the user.

## Mind integration

Every successful primitive call posts a `conversation` node to
`/api/mind/save-result` tagged `createdBy: "stagehand"`. Future CLI sessions
can query `/api/mind/query` and find the action history.
