---
name: Diagnose the running app
description: When the user asks what is going on with the site they are building, drive the in-app browser Tools endpoints to start the dev server, read console + server + network logs, inspect/eval the page, and report -- all inside Symphonee, no Chrome needed.
when: the user asks 'what is going on?', 'why isn't X working?', 'is the server up?', 'check the logs', or reports a bug on the local site being developed
tags: browser, devtools, debugging, diagnostics, tools-drawer
---

# Diagnose the running app (integrated loop)

The in-app browser Tools drawer exposes everything as REST, so you can diagnose the user's site end-to-end without leaving Symphonee or spending an LLM browser-agent loop. Do this proactively when the user is vague ('what's going on?').

## 1. Is the dev server up?
- `GET /api/git/status?repo=<activeRepo>` is irrelevant here; instead check the project's dev server:
- `GET /api/browser/server-log?lines=80` -> returns the active repo's dev-server terminal output (auto-detected), with `isDevServer` + `devUrl`.
- If it returns `termId:null` / no dev output, the server is probably not running. Start it: read `GET /api/project/scripts?repo=<activeRepo>` for the dev script, create a terminal and run it (`POST /api/orchestrator/spawn` or the terminal hub), then poll `server-log` until `devUrl` appears.

## 2. Open the page in the in-app browser
- `POST /api/browser/launch` then `POST /api/browser/navigate {url:<devUrl>}` (or the route the user mentioned).

## 3. Read the signals (all ungated)
- Console + errors: `GET /api/browser/console?limit=100` (includes uncaught exceptions).
- Network: `GET /api/browser/network?limit=100`; body of a failed call: `GET /api/browser/network-body?requestId=...`.
- Server log again: `GET /api/browser/server-log` for stack traces the browser never sees.
- DOM / element: `POST /api/browser/inspect {selector}` or `GET /api/browser/dom`.
- Anything else: `POST /api/browser/eval {expression}` runs JS in the page and returns the value (read state, reproduce the bug, check a global).

## 4. Correlate + report
- A 500 in Network + a stack trace in server-log = backend bug. A red console exception + no network call = client bug. Tell the user the specific failing request/line, not 'something is wrong'.

## 5. Fix or hand back
- If it's a code bug in the active repo, fix it (branch -> edit -> show diff). If you need the user, come back with the exact finding.

The user sees all of this live in the Tools drawer (Console / Network / Server / Elements / AI), docked bottom/left/right. Reading is permission-free; mutating (eval, style, navigate, submit) is gated -- say what you're about to do first.
