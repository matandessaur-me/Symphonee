# Permissions (Runtime-Enforced)

Permissions are enforced by the DevOps Pilot server, not by self-regulation. Current mode lives in `config.json` under `Permissions.mode`. Visible in the header chip. Read at any time: `curl -s http://127.0.0.1:3800/api/permissions`.

## Modes

- **`review`**: read-only. Writes, spawns, and external calls rejected server-side.
- **`edit`** (default): writes allowed; destructive or external actions (push, PR comments/reviews, work-item writes, spawns) require approval via the header modal.
- **`trusted`**: like `edit` but inside a git worktree everything is auto-approved.
- **`bypass`**: everything allowed. Child CLI workers also launch with YOLO flags (`--dangerously-skip-permissions` etc.). Use only when the user explicitly asks.

## Response semantics

When calling a gated endpoint, expect:

- **200** — action allowed.
- **403 `{ "permission": { "decision": "deny" } }`** — blocked by a `deny` rule or mode default. Do NOT retry or route around. Stop and tell the user what was blocked.
- **403 `{ "error": "Rejected by user: ..." }`** — user saw the approval modal and clicked Reject. Do NOT retry the same action.
- **412 `{ "error": "Approval required: ..." }`** — caller passed `wait: false` / `autoPermit: false`. Rare. Retry with `autoPermit: true` only if the user explicitly pre-authorized autonomous work.
- **Hung for up to 2 minutes, then 200 or 403** — modal is open, waiting for user. Normal. Let it resolve.

## Rules of engagement

- Do NOT change the permission mode yourself. Only the user switches modes via the chip.
- Do NOT pass `autoPermit: true` to spawn routes unprompted. Only for user-authorized autonomous batches.
- Before operations you know need approval, tell the user in one short sentence first so the modal isn't a surprise.
- If you see `403 deny`, **stop**. The user set the mode deliberately.

## What is always safe (no modal)

- Reading: GET endpoints, file reads, grep, git status/log/diff, browser reads.
- Writing to `.ai-workspace/` and Notes.
- Switching dashboard tabs.
- Local git operations that don't touch a remote.

## What is gated

- Spawning orchestrator workers (`POST /api/orchestrator/spawn`, `spawn-with-deps`, `spawn-worktree`, `spawn-escalate`, `spawn-lineage`, `fan-out`, `handoff`).
- `git push`, force push, destructive shell commands.
- Mutating plugin routes. Every plugin declares which of its routes require approval in its own `instructions.md`; the server enforces the same rules regardless of who calls them.
- Graph run create.
