# Security Model

Symphonee is a **local-first** app: a Node server and an Electron renderer that
talk over HTTP/WebSocket on `127.0.0.1:3800`. It runs high-privilege actions on
your behalf — spawning AI CLIs, running git, reading and writing files, driving
a browser and (on Windows) the desktop, and loading plugins. This document is
the honest threat model: what Symphonee defends against, what it does **not**,
and how to run it safely.

> Reporting a vulnerability: open a private security advisory on the GitHub repo,
> or email the maintainer. Please do not file public issues for exploitable bugs.

## What the server trusts

The API has **no authentication token** between the renderer and the server (a
boot-time token is planned). Access is gated only by the **request firewall**
(`dashboard/request-firewall.js`), which enforces two rules on every HTTP request
and WebSocket upgrade:

- **Origin** — a browser cross-site request always carries an `Origin` header, so
  any *foreign* Origin (a malicious web page you merely open) is rejected. The
  same-origin renderer is allowed. A request with **no** `Origin` (a local CLI,
  `curl`, server-to-server) is treated as a trusted local caller.
- **Host** — the `Host` header must be loopback, which blocks DNS-rebinding pages
  that resolve their domain to `127.0.0.1` but still send `Host: attacker.com`.
  A request with **no** `Host` header is rejected.

### What this does and does not stop

| Threat | Stopped? |
| --- | --- |
| A malicious **web page** you open in a normal browser (CSRF) | ✅ Yes — foreign Origin rejected |
| A **DNS-rebinding** page targeting `127.0.0.1:3800` | ✅ Yes — non-loopback `Host` rejected |
| Another **local process** on your machine (no `Origin`) hitting the API | ❌ **No** — see below |

Because the firewall trusts any caller that omits `Origin` (so your local CLIs
keep working), **any other process running as your user can call the full API** —
git push, file writes, plugin install, agent spawn. This is the same trust level
as any local dev server, but worth stating plainly: **Symphonee assumes every
local process running as you is trusted.** Do not run it on a shared/multi-user
machine where you would not also trust an arbitrary local process. A boot-time
bearer token (handed to the renderer and to spawned CLIs) is the planned fix.

## Permission modes — what they gate

The four runtime modes (`review` / `edit` / `trusted` / `bypass`) gate Symphonee's
**own API surface and the in-app tools** — the spawn/write/external-call paths that
go *through the server*. They are enforced server-side, not by agent etiquette.

**They do not sandbox a CLI you launch in a terminal tab.** Once you start, say,
Claude Code or Codex in a terminal, that process runs with your OS permissions and
can execute `git push` or edit files **directly**, bypassing the mode. The
activity ledger records such actions, but recording is *reactive*, not preventive.
Treat the permission mode as a guardrail against accidental in-app actions and a
consistent gate for orchestrated work — **not** as a sandbox around a CLI you have
handed a shell to.

## Plugin trust model

Plugins live in `dashboard/plugins/<id>/` and are loaded with `require()` into the
**same Node process** as the server (`dashboard/plugins-core/plugin-loader.js`).
A plugin therefore runs with **full Node privileges**: it can read and write any
file your user can, spawn processes, make network calls, and read `config.json`
(where API keys and PATs are stored in plaintext).

There is **no plugin sandbox**. Consequences:

- **Only install plugins you trust.** Review a plugin's `routes.js` before
  installing it, the same way you would review any npm dependency you `require`.
- Official plugins live in a separate, reviewable repo
  ([`Symphonee-plugins`](https://github.com/matandessaur-me/Symphonee-plugins)).
- A plugin's iframe **UI** is isolated (it talks to the host only via the
  `postMessage` `__symphonee` envelope), but its **server-side** `routes.js` is not.

## Secrets at rest

API keys, PATs, and browser credentials live in `config/config.json` and per-plugin
`config.json` files, **in plaintext**, on your disk (git-ignored). Browser
credentials are an exception — they are encrypted at rest with AES-256-GCM keyed to
the machine. Secrets are scrubbed from *shared learnings* before any sync
(`dashboard/learnings/learnings-sanitize.js`). Keep the `config/` directory out of
unencrypted backups and sync folders.

## Hardening checklist for contributors

- Any route that reads/writes a path from user input must resolve it through
  `resolveInRepo()` (`dashboard/utils/safe-path.js`) and reject escapes — never
  `fs.readFileSync(path.join(repoPath, userInput))` directly.
- Any user-supplied git ref/hash passed to a git command must pass
  `isUnsafeGitRef()` first (blocks `-`-prefixed flag injection and shell metachars).
- Prefer `spawn`/`execFile` with an argument array over `exec`/`execSync` with an
  interpolated string.
