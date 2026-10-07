@echo off
chcp 65001 >nul
title Zed Gateway - Sign-in via Proxy

REM ============================================================
REM  Sign-in script: sets system proxy, opens browser, waits
REM  for user to finish, then clears proxy and launches gateway
REM ============================================================

cd /d "%~dp0"

if "%1"=="" (
    echo Usage: sign-in-with-proxy.bat PROXY_HOST:PORT USERNAME PASSWORD
    echo.
    echo Example: sign-in-with-proxy.bat 31.59.20.176:6754 vdvydvqn 1qj8nwix6m7p
    echo.
    pause
    exit /b 1
)

set PROXY_SERVER=%1
set PROXY_USER=%2
set PROXY_PASS=%3

echo ============================================================
echo  Zed Gateway - Sign-in via Proxy
echo ============================================================
echo.
echo  Proxy: %PROXY_SERVER%
echo.

REM --- Step 1: Set system proxy ---
echo [1/4] Setting system proxy...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "%PROXY_SERVER%" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyOverride /t REG_SZ /d "<local>;localhost;127.0.0.1" /f >nul
echo  Done. System proxy: %PROXY_SERVER%
echo.

REM --- Step 2: Open browser ---
echo [2/4] Opening browser to zed.dev...
start "" "https://zed.dev/account"
echo  Browser opened. Register/login on zed.dev
echo  Then open Zed IDE and login there too.
echo.
echo  When fully logged in, come back here and press any key.
echo.
pause

REM --- Step 3: Extract token ---
echo [3/4] Extracting token from Credential Manager...
node src\extract.mjs
echo.
echo  Token extracted. Check admin panel if needed.
echo  Press any key to CLEAR proxy and continue.
pause

REM --- Step 4: Clear system proxy ---
echo [4/4] Clearing system proxy...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul
echo  Done. System proxy CLEARED.
echo  Your internet is back to normal.
echo.

REM --- Launch gateway ---
echo ============================================================
echo  Launching Zed Gateway...
echo  Admin: http://127.0.0.1:18090/admin
echo ============================================================
echo.
start "" "http://127.0.0.1:18090/admin"
node src\gateway.mjs config.json
pause