---
name: Verify a frontend edit
description: How to safely validate edits to Symphonee's dashboard frontend -- especially the large dashboard/public/index.html with its many inline scripts -- before showing a diff or committing.
when: editing dashboard/public/index.html, mind-ui.js, or other browser-side files
tags: frontend, verification, quality
---

# Verify a frontend edit

`dashboard/public/index.html` is one large file with ~7 inline `<script>` blocks
and one shared top-level scope (a `let` declared in one block is visible to a
handler defined earlier, because handlers run at message-time after the whole
block executed). A bad edit there silently breaks the renderer.

## Use when
- Editing `dashboard/public/index.html` (inline scripts) or `public/*.js`.

## Steps (primary path)
1. After the edit, compile every inline script block. `node --check` cannot read
   HTML, so extract `<script>` blocks (skip `src=` and non-JS `type=`) and run
   each through `new vm.Script(code)`; report any block with a syntax error.
2. For standalone JS (`public/mind-ui.js`, modules): `node --check <file>`.
3. Watch scope across blocks: top-level `function` declarations are global, but
   `let`/`const` are scoped to their script block. If a handler references a
   `let` from another block, confirm both are in the SAME inline block, or expose
   the value on `window`.
4. Then proceed to `ship-a-change` (show the diff as its own step, etc.).

## Safety
- Do not assume an inline edit is fine because it "looks like a one-liner" -- the
  vm.Script pass is cheap and catches the breakage the browser would only show at
  runtime.

## Verification
- The inline-script check reports 0 errors across all blocks.
- `node --check` passes for any standalone JS touched.
