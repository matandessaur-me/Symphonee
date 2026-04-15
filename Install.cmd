@echo off
echo ========================================
echo   Symphonee - Installation
echo ========================================
echo.

echo Checking Node.js...
node --version
if errorlevel 1 (
    echo Node.js not found. Install from https://nodejs.org
    exit /b 1
)

echo.
echo Checking for updates...
git fetch origin master >nul 2>&1
for /f %%i in ('git rev-parse HEAD') do set LOCAL=%%i
for /f %%i in ('git rev-parse origin/master') do set REMOTE=%%i
if not "%LOCAL%"=="%REMOTE%" (
    echo Updates found, pulling latest changes...
    git pull origin master
    echo.
) else (
    echo Already up to date.
    echo.
)

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
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Create-Shortcut.ps1

echo.
echo ========================================
echo   Installation complete!
echo   Launch from the "Symphonee" desktop shortcut.
echo ========================================
pause
