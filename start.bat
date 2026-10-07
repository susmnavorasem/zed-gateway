@echo off
title Zed Gateway Server
cd /d "%~dp0"
echo [1/3] Freeing port 18090...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":18090" ^| find "LISTENING"') do (
    echo Killing PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/3] Starting Zed Gateway...
start "" "http://127.0.0.1:18090/admin"

echo [3/3] Gateway is running. Do not close this window.
node src\gateway.mjs config.json

echo.
echo Gateway stopped.
pause
