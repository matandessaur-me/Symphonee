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

Access is gated by two layers: the **request firewall** and a **per-boot auth
token** for state-mutating requests.

### Layer 1 — the request firewall (`dashboard/request-firewall.js`)

Enforced on every HTTP request and WebSocket upgrade:

- **Origin** — a browser cross-site request always carries an `Origin` header, so
  any *foreign* Origin (a malicious web page you merely open) is rejected. The
  same-origin renderer is allowed. A request with **no** `Origin` (a local CLI,
  `curl`, server-to-server) is treated as a trusted local caller.
- **Host** — the `Host` header must be loopback, which blocks DNS-rebinding pages
  that resolve their domain to `127.0.0.1` but still send `Host: attacker.com`.
  A request with **no** `Host` header is rejected.

### Layer 2 — the per-boot auth token (`dashboard/lib/auth-token.js`)

The firewall trusts any local caller that omits `Origin` (so your CLIs work),
which on its own would let **any other local process drive privileged actions**.
The token closes that: every **state-mutating** request (`POST`/`PUT`/`DELETE`/
`PATCH`) must carry an `X-Symphonee-Token` header matching a random token minted
at server start. It reaches legitimate callers automatically:

- the **renderer** — injected into served HTML; a `fetch`/XHR wrapper attaches it,
- **spawned CLIs** — via the `SYMPHONEE_TOKEN` environment variable they inherit,
- **PowerShell helpers** — `scripts/_ApiInit.ps1` reads the env var or the runtime
  file and attaches it,
- the **MCP bridge** — reads it from `config/runtime.json` (mode 0600).

`GET`/`HEAD` reads stay firewall-only **by design**: a local process running as
you can already read your files and config straight off disk, so token-gating
reads would add cost without real confidentiality. The token protects the things
a process *can't* otherwise do — `git push` with your PAT, plugin install (which
is code execution inside the server), agent spawn, file writes.

Enforcement is on by default; set `Security.RequireApiToken: false` in
`config/config.json` to disable it (e.g. to debug a custom integration).

### What this does and does not stop

| Threat | Stopped? |
| --- | --- |
| A malicious **web page** you open in a normal browser (CSRF) | ✅ Yes — foreign Origin rejected |
| A **DNS-rebinding** page targeting `127.0.0.1:3800` | ✅ Yes — non-loopback `Host` rejected |
| Another **local process** performing a privileged **action** (push/install/spawn/write) | ✅ Yes — mutation needs the token |
| Another **local process** **reading** via the API (GET) | ❌ No — by design (it can read your disk anyway) |

**Symphonee still assumes the machine itself is trusted** — a process running as
you can read your files directly. Don't run it on a shared/multi-user box where
you wouldn't trust an arbitrary local process.

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
