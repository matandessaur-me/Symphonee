param(
    [Parameter(Mandatory=$true)]
    [int]$Id,

    [Parameter(Mandatory=$true)]
    [ValidateSet('New','Active','Resolved','Closed')]
    [string]$State,

    [string]$ApiBase = "http://127.0.0.1:3800"
)

$body = @{ state = $State } | ConvertTo-Json -Compress
$result = Invoke-RestMethod "$ApiBase/api/workitems/$Id/state" -Method PATCH -ContentType 'application/json' -Body $body

if ($result.ok) {
    Write-Host "`n  #$($result.id) -> $($result.state)" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "`n  Error: $($result.error)`n" -ForegroundColor Red
}
