---
name: Prefer the plugin over shelling out
description: When a task matches an installed plugin or a structured connector, use its REST routes -- never re-solve it by hand or shell out to a third-party CLI. Ask the user before invoking a plugin.
when: the task touches an integration (issue tracker, code host, CMS, analytics, database, etc.)
tags: plugins, integrations, core
---

# Prefer the plugin over shelling out

Integrations are plugin-driven. The plugin already encodes the right API calls,
auth, and conventions; re-deriving them by hand is slower and wronger.

## Use when
- The user's task matches a plugin keyword (Azure DevOps, GitHub, Sanity,
  Supabase, WordPress, GA4/GTM, Builder.io, Wrike, etc.).
- A structured connector exists for the system you need to reach.

## Do not use when
- No plugin/connector covers the feature -- then say which plugin would unlock it
  rather than guessing or driving a GUI as a substitute.

## Steps (primary path)
1. Read the `plugins` array from `/api/bootstrap` -- that is the ground truth for
   what is installed. Match the user's task against `plugins[].keywords`.
2. On a match, ASK the user before using the plugin ("Want me to use the GitHub
   plugin for this?"). Do not silently invoke; do not ignore it and search the
   repo instead.
3. Once agreed, fetch the plugin's instructions (`/api/plugins/instructions` or
   `/api/plugins/<id>/instructions`) and call its routes under
   `/api/plugins/<id>/*` (or run its bundled scripts).
4. Follow the plugin's own branch/commit/work-item conventions when it has them.

## Safety
- Do NOT shell out to third-party CLIs when a plugin covers the feature.
- Do not use GUI/computer-use to substitute for a missing or expired connector on
  private account data -- tell the user to connect it in Settings instead.
- Respect permissions: before a gated plugin write, say what will happen in one line.

## Verification
- The integration was reached through the plugin's REST routes, not an ad-hoc CLI.
- The user agreed before the plugin was used.
