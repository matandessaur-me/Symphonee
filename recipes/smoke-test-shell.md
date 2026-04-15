---
name: Smoke Test Shell
description: Verify plugin-first shell startup, provider gates, and bundled ADO/GitHub plugin surfaces
icon: shield-check
intent: deep-code
mode: edit
inputs:
  - name: repo
    type: repo
    description: Configured repo name to test
    default: "{{ context.activeRepo }}"
    required: true
---

You are smoke-testing the plugin-first Symphonee shell for `{{ inputs.repo }}`.

Run everything from the Symphonee directory. Do not edit files, commit, push, install plugins, uninstall plugins, or change settings. Use `Invoke-RestMethod` in PowerShell or `curl` in bash. Plain ASCII only.

## Checks

1. Bootstrap and context
   - Call `GET /api/bootstrap`.
   - Record `context.activeRepo`, `context.activeRepoPath`, `permissions.settings.mode`, and `checksum`.
   - Confirm the response includes `plugins`, `instructions`, `learnings`, and `features`.

2. Plugin endpoint consistency
   - Call `GET /api/plugins`.
   - Call `GET /api/plugins/contributions`.
   - Confirm every item in the typed contributions payload has `_origin.pluginId`.
   - Confirm active ADO/GitHub plugins, when configured, appear in both the full manifest list and the typed contributions payload.
   - Confirm unconfigured ADO/GitHub plugins are absent from both active-plugin endpoints and that their direct routes return a 404 with `pluginRequired`.

3. Bundled first-party plugin files
   - Confirm these files exist:
     - `dashboard/plugins/azure-devops/plugin.json`
     - `dashboard/plugins/azure-devops/instructions.md`
     - `dashboard/plugins/github/plugin.json`
     - `dashboard/plugins/github/instructions.md`
   - Confirm root scripts that were moved to plugins are not present in `scripts/`:
     - `Find-WorkItems.ps1`
     - `Get-MyWorkItems.ps1`
     - `Get-SprintStatus.ps1`
     - `New-PullRequest.ps1`
     - `Push-AndPR.ps1`

4. Provider contribution contracts
   - In `/api/plugins/contributions`, confirm:
     - A work item provider has `listRoute`, `getRoute`, and `createRoute` when Azure DevOps is active.
     - A PR provider has `listRoute`, `detailRoute`, and `createRoute` when GitHub is active.
     - Commit linkers use `urlTemplate`, not `resolveRoute`.
   - Confirm relative plugin routes documented as `/something` resolve as plugin-relative by inspecting `dashboard/public/contributions-client.js`.

5. Core route gates
   - If Azure DevOps is not active, call `GET /api/workitems` and confirm 404 plus `pluginRequired: "azure-devops"`.
   - If GitHub is not active, call `GET /api/github/pulls?repo={{ inputs.repo }}` and confirm 404 plus `pluginRequired: "github"`.
   - If either plugin is active, call only safe read endpoints and report whether they returned data or a service/config error.

6. Static validation
   - Run `node --check dashboard/server.js`.
   - Run `node --check dashboard/plugin-loader.js`.
   - Run `node --check dashboard/public/contributions-client.js`.
   - Run `node --check scripts/save-note.js`.

7. Remaining known gaps
   - Search for hardcoded provider routes in core UI:
     - `/api/github/`
     - `/api/workitems`
     - `Clone from GitHub`
     - `Azure DevOps (optional)`
   - Report whether each hit is still intentionally native-claimed compatibility UI or a blocker for the pure-shell target.

## Report

Print a concise report with:

- **Environment**: repo, branch, permission mode, checksum.
- **Passes**: checks that passed.
- **Failures**: checks that failed, with file paths or endpoints.
- **Pure-shell gaps**: anything still hardcoded in core.
- **Verdict**: `ready`, `ready with caveats`, or `not ready`.

Do not use terminal `git diff`. If the user asks to inspect changes visually, run `.\scripts\Show-Diff.ps1 -Repo "{{ inputs.repo }}"` from the Symphonee directory.
