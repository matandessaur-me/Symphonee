param(
  [string]$Id = ""
)

# List or inspect recipes.
# Usage:
#   ./scripts/Get-Recipes.ps1                # list all
#   ./scripts/Get-Recipes.ps1 -Id sprint-review

if ($Id) {
  try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:3800/api/recipes/$Id" -Method Get }
  catch { Write-Error ($_.ErrorDetails.Message ?? $_.Exception.Message); exit 1 }
  Write-Host "$($r.name) [$($r.id)]" -ForegroundColor Cyan
  Write-Host "  description: $($r.description)"
  Write-Host "  scope:       $($r.scope)"
  Write-Host "  intent:      $($r.intent)"
  if ($r.cli)   { Write-Host "  cli:         $($r.cli)" }
  if ($r.model) { Write-Host "  model:       $($r.model)" }
  if ($r.mode)  { Write-Host "  mode:        $($r.mode) (advisory)" }
  if ($r.plugins.Count)    { Write-Host "  plugins:     $($r.plugins -join ', ')" }
  if ($r.mcpServers.Count) { Write-Host "  mcpServers:  $($r.mcpServers -join ', ')" }
  if ($r.inputs.Count) {
    Write-Host "  inputs:" -ForegroundColor Yellow
    foreach ($i in $r.inputs) {
      $req = if ($i.required) { ' (required)' } else { '' }
      $def = if ($i.default -ne $null -and $i.default -ne '') { " default=$($i.default)" } else { '' }
      Write-Host ("    {0,-15} {1}{2}{3}" -f $i.name, $i.type, $req, $def)
    }
  }
  Write-Host ""
  Write-Host "Body preview:" -ForegroundColor Yellow
  $body = $r.body.Substring(0, [Math]::Min(400, $r.body.Length))
  Write-Host $body
} else {
  try { $list = Invoke-RestMethod -Uri 'http://127.0.0.1:3800/api/recipes' -Method Get }
  catch { Write-Error ($_.ErrorDetails.Message ?? $_.Exception.Message); exit 1 }
  if (-not $list -or $list.Count -eq 0) { Write-Host "No recipes found in recipes/."; return }
  Write-Host ("{0,-22} {1,-30} {2,-15} {3}" -f 'ID', 'NAME', 'INTENT', 'INPUTS')
  foreach ($r in $list) {
    $inp = ($r.inputs | ForEach-Object { $_.name }) -join ','
    Write-Host ("{0,-22} {1,-30} {2,-15} {3}" -f $r.id, $r.name, $r.intent, $inp)
  }
}
