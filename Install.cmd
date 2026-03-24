@echo off
echo ========================================
echo   DevOps Pilot - Installation
echo ========================================
echo.

echo Checking Node.js...
node --version
if errorlevel 1 (
    echo Node.js not found. Install from https://nodejs.org
    exit /b 1
)

echo.
echo Setting PowerShell execution policy...
powershell -NoProfile -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force"

echo.
echo Installing dependencies...
call npm install

echo.
echo Setting app icon...
node_modules\rcedit\bin\rcedit-x64.exe node_modules\electron\dist\electron.exe --set-icon dashboard\public\icon.ico

echo.
echo Creating desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File dashboard\create-shortcut.ps1

echo.
echo ========================================
echo   Installation complete!
echo   Launch from the "DevOps Pilot" desktop shortcut.
echo ========================================
pause
