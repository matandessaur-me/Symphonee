---
name: Sprint Review
description: Pull every closed work item in the iteration and produce a standup-ready markdown summary
icon: clipboard-list
intent: deep-code
mode: edit
inputs:
  - name: iteration
    type: string
    default: "{{ context.selectedIterationName }}"
    required: true
---

You are reviewing sprint **{{ inputs.iteration }}** for the active Azure DevOps project.

Steps:

1. Run `./scripts/Find-WorkItems.ps1 -Search '' -State Closed` (filtered to the iteration if possible) and `./scripts/Find-WorkItems.ps1 -Search '' -State Resolved` to gather all closed and resolved items.
2. Group them by assignee and by type (User Story, Bug, Task, Feature).
3. For each item, capture id, title, story points, and one-line outcome.
4. Compute total story points completed and compare to the team's recent average if available via `./scripts/Get-Velocity.ps1` (skip if not present).
5. Flag any items that were carried over from a prior sprint (state=Active before this iteration started).
6. Produce a single markdown document with sections: Headline, Velocity, By Engineer, Carry-overs, Blockers Resolved, Highlights.
7. Save the document as a note titled "Sprint Review {{ inputs.iteration }}" via `node scripts/save-note.js`.

Be concise. Plain ASCII only. No emojis, no em dashes.
