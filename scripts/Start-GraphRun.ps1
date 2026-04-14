param(
  [Parameter(Mandatory = $true)]
  [string]$File,

  [string]$Name = ""
)

# Starts a new graph run from a JSON definition file.
# The file must be valid JSON matching the graph-runs schema: { name, state, nodes: [...] }.
#
# Example graph file:
#   {
#     "name": "Sprint Review",
#     "state": { "iteration": "Sprint 42" },
#     "nodes": [
#       { "id": "pull", "type": "worker", "cli": "claude", "prompt": "List items in {{ state.iteration }}." },
#       { "id": "check", "type": "approval", "title": "Pulled data looks right?", "dependsOn": ["pull"] },
#       { "id": "summary", "type": "worker", "cli": "gemini", "prompt": "Summarize {{ state.results.pull.result }}", "dependsOn": ["check"] }
#     ]
#   }
#
# Usage:
#   ./scripts/Start-GraphRun.ps1 -File .ai-workspace/my-graph.json
#   ./scripts/Start-GraphRun.ps1 -File .ai-workspace/my-graph.json -Name 'Custom run name'

if (-not (Test-Path $File)) {
  Write-Error "File not found: $File"
  exit 1
}

$raw = Get-Content $File -Raw -Encoding UTF8
try {
  $def = $raw | ConvertFrom-Json
} catch {
  Write-Error "Failed to parse JSON from ${File}: $_"
  exit 1
}

if ($Name) { $def | Add-Member -NotePropertyName name -NotePropertyValue $Name -Force }
if (-not $def.name) { $def | Add-Member -NotePropertyName name -NotePropertyValue ([IO.Path]::GetFileNameWithoutExtension($File)) -Force }

# Pass the current DevOps Pilot terminal id so the engine can inject the
# final result back into this terminal when the run completes.
if ($env:DEVOPS_PILOT_TERM_ID) {
  $def | Add-Member -NotePropertyName originTermId -NotePropertyValue $env:DEVOPS_PILOT_TERM_ID -Force
}

$body = $def | ConvertTo-Json -Depth 12

try {
  $res = Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/graph-runs' -Method Post -Body $body -ContentType 'application/json'
  Write-Host "Graph run started." -ForegroundColor Green
  Write-Host "  id:     $($res.id)"
  Write-Host "  name:   $($res.name)"
  Write-Host "  status: $($res.status)"
  Write-Host ""
  Write-Host "Track it:"
  Write-Host "  ./scripts/Get-GraphRun.ps1 -Id $($res.id)"
} catch {
  $msg = $_.ErrorDetails.Message
  if (-not $msg) { $msg = $_.Exception.Message }
  Write-Error "Failed to start graph run: $msg"
  exit 1
}
