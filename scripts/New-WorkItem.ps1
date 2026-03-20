param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('User Story','Bug','Task','Feature','Epic')]
    [string]$Type,

    [Parameter(Mandatory=$true)]
    [string]$Title,

    [string]$Description = "",
    [int]$Priority = 2,
    [string]$AssignedTo = "",
    [string]$Tags = "",
    [double]$StoryPoints = 0,
    [string]$AcceptanceCriteria = "",
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$body = @{
    type = $Type
    title = $Title
}

if ($Description)       { $body.description = $Description }
if ($Priority)          { $body.priority = $Priority }
if ($AssignedTo)        { $body.assignedTo = $AssignedTo }
if ($Tags)              { $body.tags = $Tags }
if ($StoryPoints -gt 0) { $body.storyPoints = $StoryPoints }
if ($AcceptanceCriteria) { $body.acceptanceCriteria = $AcceptanceCriteria }

$json = $body | ConvertTo-Json -Compress
$result = Invoke-RestMethod "$ApiBase/api/workitems/create" -Method POST -ContentType 'application/json' -Body $json

if ($result.ok) {
    Write-Host "`n  Created #$($result.id): $($result.title)" -ForegroundColor Green
    if ($result.url) { Write-Host "  $($result.url)" -ForegroundColor DarkGray }
    Write-Host ""

    # Hint: To show this in the dashboard, the AI can run:
    # Invoke-RestMethod "$ApiBase/api/ui/view-workitem" -Method POST -ContentType 'application/json' -Body "{`"id`":$($result.id)}"
} else {
    Write-Host "`n  Error: $($result.error)`n" -ForegroundColor Red
}
