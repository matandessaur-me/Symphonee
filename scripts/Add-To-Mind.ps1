# Add a single artefact to the Mind graph - a URL, a note name, or a
# manual concept node. URLs go through SSRF guards.
#
# Usage:
#   .\scripts\Add-To-Mind.ps1 -Url "https://example.com/spec.md" -Label "API spec"
#   .\scripts\Add-To-Mind.ps1 -Path ".\docs\ADR-007.md" -Label "ADR 7" -Kind doc
[CmdletBinding()]
param(
    [string]$Url,
    [string]$Path,
    [string]$Label,
    [ValidateSet('note','code','doc','paper','image','workitem','recipe','conversation','plugin','concept','tag')]
    [string]$Kind = 'concept',
    [string[]]$Tags = @(),
    [string]$CreatedBy = 'manual'
)

$body = @{
    url = $Url
    path = $Path
    label = $Label
    kind = $Kind
    tags = $Tags
    createdBy = $CreatedBy
} | ConvertTo-Json -Compress

$resp = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3800/api/mind/add' `
    -ContentType 'application/json' -Body $body
$resp | ConvertTo-Json -Depth 3
