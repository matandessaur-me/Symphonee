---
name: Standup Summary
description: Generate a concise daily standup summary from recent work item activity
icon: users
intent: quick-summary
mode: edit
inputs:
  - name: hours
    type: number
    default: 24
    required: false
---

You are producing today's standup summary for the active Azure DevOps team.

Steps:

1. Run `./scripts/Get-StandupSummary.ps1` to pull recent work item changes (last {{ inputs.hours }} hours).
2. Group activity by engineer.
3. For each engineer, list under three headings:
   - Yesterday: items moved to Resolved or Closed
   - Today: items currently Active assigned to them
   - Blockers: items stuck in the same state for more than 2 working days, or items tagged with `blocked`
4. End with a short team-level rollup: total items in flight, items at risk, anything needing a decision today.
5. Save the document as a note titled "Standup {{ context.selectedIterationName }} - $(date +%Y-%m-%d)" via `node scripts/save-note.js`.

Plain ASCII only. Be terse; standup notes are read in 30 seconds.
