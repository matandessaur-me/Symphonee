param(
    [Parameter(Mandatory=$true)]
    [string]$Name,

    [Parameter(Mandatory=$false)]
    [string]$Content,

    [Parameter(Mandatory=$false)]
    [string]$FilePath,

    [string]$ApiBase = "http://127.0.0.1:3800"
)

# Read content from file if -FilePath is provided
if ($FilePath) {
    if (!(Test-Path $FilePath)) { Write-Host "`n  Error: File not found: $FilePath`n" -ForegroundColor Red; exit 1 }
    $Content = Get-Content -Raw $FilePath
}
if (!$Content) { Write-Host "`n  Error: Provide either -Content or -FilePath`n" -ForegroundColor Red; exit 1 }

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
