@echo off
chcp 65001 > NUL
title NexusCore Host Daemon (Windows Test-Runner)
cd /d "%~dp0"

echo ========================================================
echo   ⚡ Starte NexusCore im lokalen Windows Testmodus...
echo ========================================================
echo.

if not exist "node_modules" (
    echo Installiere erforderliche Abhängigkeiten...
    call npm install
)

echo Starte NexusCore Daemon...
call npm run dev
