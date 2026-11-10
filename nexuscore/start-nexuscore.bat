@echo off
chcp 65001 > NUL
title NexusCore Host Daemon (Windows)
cd /d "%~dp0"

echo ========================================================
echo   NEXUSCORE HOST DAEMON - lokaler Windows-Testbetrieb
echo ========================================================
echo.

if not exist "node_modules" (
  echo Installiere Abhaengigkeiten...
  call npm install
  if errorlevel 1 (
    echo INSTALLATION FEHLGESCHLAGEN.
    pause
    exit /b 1
  )
)

echo Baue NexusCore...
call npm run build
if errorlevel 1 (
  echo BUILD FEHLGESCHLAGEN.
  pause
  exit /b 1
)

echo.
echo Starte Daemon (Beenden mit Strg+C)...
echo.
call npm start
