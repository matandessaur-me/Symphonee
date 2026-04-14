---
name: Release Notes
description: Draft release notes from closed items in the iteration plus merged GitHub PRs
icon: file-text
intent: deep-code
mode: edit
inputs:
  - name: iteration
    type: string
    default: "{{ context.selectedIterationName }}"
    required: true
  - name: version
    type: string
    required: true
---

You are drafting release notes for **version {{ inputs.version }}** covering iteration **{{ inputs.iteration }}**.

Steps:

1. Pull all Resolved and Closed work items in the iteration via `./scripts/Find-WorkItems.ps1`.
2. Pull merged GitHub PRs for the active repo via `curl -s "http://127.0.0.1:3800/api/github/pulls?state=closed&repo={{ context.activeRepo }}"`. Filter to PRs whose merge date falls inside the iteration window.
3. Map each work item to its linked PR(s) using `AB#<id>` references in commit messages.
4. Categorize entries into: New Features, Improvements, Bug Fixes, Internal / Refactor.
5. Within each category, write one customer-facing line per item. Include the work item id in parentheses.
6. Add a "Known Issues" section listing any open Bug items in the iteration that did not close.
7. Add a "Contributors" section listing engineers who closed items.
8. Save as a note titled "Release Notes {{ inputs.version }}" via `node scripts/save-note.js`.

Plain ASCII only. No emojis, no em dashes. Tone: clear and professional.
