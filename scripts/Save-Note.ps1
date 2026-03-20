param(
    [Parameter(Mandatory=$true)]
    [string]$Name,

    [Parameter(Mandatory=$true)]
    [string]$Content,

    [string]$ApiBase = "http://127.0.0.1:3800"
)

# Create note if it doesn't exist
Invoke-RestMethod "$ApiBase/api/notes/create" -Method POST -ContentType 'application/json' -Body (@{ name = $Name } | ConvertTo-Json -Compress) -ErrorAction SilentlyContinue | Out-Null

# Save content
$body = @{ name = $Name; content = $Content } | ConvertTo-Json -Compress
$result = Invoke-RestMethod "$ApiBase/api/notes/save" -Method POST -ContentType 'application/json' -Body $body

if ($result.ok) {
    Write-Host "`n  Note '$Name' saved." -ForegroundColor Green

    # Hint: To open this note in the dashboard, the AI can run:
    # Invoke-RestMethod "$ApiBase/api/ui/view-note" -Method POST -ContentType 'application/json' -Body (@{name=$Name}|ConvertTo-Json -Compress)
    Write-Host ""
} else {
    Write-Host "`n  Error: $($result.error)`n" -ForegroundColor Red
}
