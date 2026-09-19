@echo off
title V Living Trading Tracker
cd /d "%~dp0"
color F0

echo.
echo    V LIVING TRADING - TRACKER
echo    ================================
echo.

REM already running? just bring it up in the browser rather than failing on the port
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo    The tracker is already running - opening it now.
  echo.
  start "" http://localhost:3000
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo    Node.js is not installed on this computer.
  echo.
  echo    Install it once from https://nodejs.org
  echo    ^(choose the "LTS" download^), then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo    First run on this computer - setting up.
  echo    This takes a minute or two. Please wait...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo    Setup failed. Please send this window to whoever set up the tracker.
    echo.
    pause
    exit /b 1
  )
  echo.
)

echo    Starting up - your browser will open in a moment.
echo.
echo    ------------------------------------------------
echo     KEEP THIS WINDOW OPEN while you use the tracker.
echo     Closing this window shuts the tracker down.
echo    ------------------------------------------------
echo.

REM wait until the server is actually answering, then open the browser
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 40;$i++){try{Invoke-WebRequest -Uri 'http://localhost:3000/login.html' -UseBasicParsing -TimeoutSec 1 ^| Out-Null; Start-Process 'http://localhost:3000'; break}catch{Start-Sleep -Milliseconds 500}}"

node server.js

echo.
echo    The tracker has stopped.
echo.
pause
