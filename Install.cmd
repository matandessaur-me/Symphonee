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
echo Installing dependencies...
call npm install

echo.
echo ========================================
echo   Installation complete!
echo   Run: npm run electron
echo ========================================
pause
