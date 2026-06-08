---
name: Ship a code change
description: The disciplined way to make and land a code change in a Symphonee-managed repo -- branch, implement, verify, show the diff as its own step, then commit. Use for any implement/fix/refactor task that ends in a commit.
when: the user asks you to implement, fix, change, or ship code
tags: workflow, git, core
---

# Ship a code change

The repeatable procedure for landing a change correctly and consistently. Follow
every step in order; the order is load-bearing.

## Use when
- The user asks you to implement a feature, fix a bug, refactor, or "ship it".
- Any task whose natural end state is a commit in a managed repo.

## Do not use when
- The user only wants an explanation, a search, or a read-only answer (no edit).
- The work is a one-line throwaway in a scratch file with no commit.

## Steps (primary path)
1. Work in the active repo only: read `activeRepoPath` from `/api/ui/context`; do
   all file/git operations there. Never ask "which repo?" -- it is already chosen.
2. If on the default branch (master/main), create a feature branch first. Never
   develop a feature directly on the default branch.
3. Implement the change in small, coherent edits that match the surrounding code's
   style, naming, and comment density.
4. Verify before showing anything:
   - JS modules: `node --check <file>`.
   - Renderer edits (`app/src/shell/*`, `mind-ui/src/*`, or `index.html` inline
     scripts): edit the SOURCE, run `npm run build:renderer`, and NEVER hand-edit
     the generated `dashboard/public/js/app.js` or `mind-ui.js` (see the
     `verify-frontend-edit` skill). Commit both source and rebuilt output.
   - Run any fast, relevant unit check.
5. Show the diff as its OWN step, then PAUSE. Use the built-in diff viewer
   (`/api/ui/view-diff`, or `Show-Diff.ps1 -Repo '<name>'` where available) --
   never `git diff` in the terminal, never an external editor. Do NOT bundle the
   diff with the commit: the viewer shows only WORKING (uncommitted) changes, so
   committing first leaves the user staring at an empty diff.
6. Commit only after the diff is shown and (when a human is present) acknowledged.
   Write a clear message: a concise subject plus a body explaining the why.
7. Push or merge ONLY if the user explicitly asked. Default is commit-locally-only.

## Safety
- Never `git diff` in the terminal; never open VS Code or external editors -- use
  the built-in file/diff viewers.
- Never push, merge, force-push, skip hooks, or do anything outward-facing unless
  the user explicitly authorized it this turn.
- On `403 deny` / rejected-by-user from a gated operation: stop. Do not retry or
  route around.
- Before a gated operation, tell the user in one short sentence what is about to
  happen so the approval modal is not a surprise.

## Verification
- The change builds / type-checks / passes `node --check` (or rebuilds cleanly for
  renderer edits).
- The diff was shown in the built-in viewer as its own step.
- The commit exists with a clear message; nothing was pushed/merged unless asked.
- If you said it is done, it is actually done and verified -- no hedging.
