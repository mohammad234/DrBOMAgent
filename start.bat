@echo off
title Dr. BOM Agent
echo.
echo   ==========================================
echo     Dr. BOM Agent - Launcher
echo   ==========================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] Node.js is NOT installed on this machine.
    echo.
    echo   This tool requires Node.js v18 or later to run.
    echo.
    echo   Please download and install Node.js from:
    echo   https://nodejs.org/en/download/
    echo.
    echo   After installing, close this window and run start.bat again.
    echo.
    pause
    exit /b 1
)

:: Check Node version
for /f "tokens=1 delims=v" %%i in ('node -v') do set NODE_VER=%%i
for /f "tokens=1 delims=v." %%i in ('node -v') do set NODE_MAJOR=%%i
echo   Node.js found: %NODE_VER%

:: Check if npm is available
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   [ERROR] npm is not available. Please reinstall Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo   npm found: OK
echo.

:: Install dependencies if node_modules doesn't exist
if not exist "node_modules\" (
    echo   Installing dependencies (first-time setup)...
    echo.
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo.
        echo   [ERROR] Failed to install dependencies.
        echo   Check your internet connection and try again.
        pause
        exit /b 1
    )
    echo.
    echo   Dependencies installed successfully!
    echo.
)

:: Start the server (with interactive setup for Azure login + LLM)
echo   Starting Dr. BOM Agent...
echo   You will be asked to optionally login to Azure and configure AI.
echo   Press Enter to skip any prompt.
echo.
node server.js
pause
