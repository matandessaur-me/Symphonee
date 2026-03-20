param(
    [string]$RepoDir = (Split-Path $PSScriptRoot -Parent)
)

$electronPath = Join-Path $RepoDir "node_modules\.bin\electron.cmd"
$iconPath = Join-Path $RepoDir "dashboard\public\icon.ico"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "DevOps Pilot.lnk"

# Generate .ico from PNG if needed
if (-not (Test-Path $iconPath)) {
    $pngPath = Join-Path $RepoDir "dashboard\public\icon.png"
    if (Test-Path $pngPath) {
        $png = [System.IO.File]::ReadAllBytes($pngPath)
        $hdr = New-Object byte[] 22
        [BitConverter]::GetBytes([uint16]0).CopyTo($hdr, 0)
        [BitConverter]::GetBytes([uint16]1).CopyTo($hdr, 2)
        [BitConverter]::GetBytes([uint16]1).CopyTo($hdr, 4)
        $hdr[6] = 0; $hdr[7] = 0; $hdr[8] = 0; $hdr[9] = 0
        [BitConverter]::GetBytes([uint16]1).CopyTo($hdr, 10)
        [BitConverter]::GetBytes([uint16]32).CopyTo($hdr, 12)
        [BitConverter]::GetBytes([uint32]$png.Length).CopyTo($hdr, 14)
        [BitConverter]::GetBytes([uint32]22).CopyTo($hdr, 18)
        $ico = $hdr + $png
        [System.IO.File]::WriteAllBytes($iconPath, $ico)
        Write-Host "  [OK] icon.ico generated"
    }
}

# Create shortcut
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronPath
$shortcut.Arguments = "."
$shortcut.WorkingDirectory = $RepoDir
$shortcut.IconLocation = $iconPath
$shortcut.Description = "DevOps Pilot - AI-powered Azure DevOps workstation"
$shortcut.Save()

Write-Host "  [OK] Desktop shortcut created: $shortcutPath"
