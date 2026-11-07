@echo off
REM NexusPanel - Updater
REM
REM   deploy.bat              Tests, hochladen, bauen, neu starten
REM   deploy.bat restart      nur neu starten
REM   deploy.bat stop         anhalten
REM   deploy.bat logs         Logs mitlesen
REM   deploy.bat status       Zustand abfragen
REM   deploy.bat monitor      Live-Anzeige mit Auslastung
REM   deploy.bat shell        SSH-Sitzung oeffnen
REM   deploy.bat test-games   Alle Spiele nacheinander im Hintergrund testen
REM   deploy.bat test-games-logs Test-Fortschritt ansehen
REM
REM In PowerShell mit .\deploy.bat aufrufen, nicht nur deploy.bat

setlocal enabledelayedexpansion

REM Bei Doppelklick das Fenster am Ende offen halten
set KEEPOPEN=0
echo %cmdcmdline% | find /i "%~nx0" >nul 2>&1 && set KEEPOPEN=1

echo.
echo  NexusPanel Updater
echo  ==================
echo.

cd /d "%~dp0"

if not exist "%~dp0deploy\deploy.ps1" (
    echo  [x] deploy\deploy.ps1 nicht gefunden.
    echo      Diese Datei gehoert in den Projektordner, neben den Ordner deploy\
    goto :ende
)

if not exist "%~dp0deploy\deploy.config.json" (
    echo  [x] deploy\deploy.config.json fehlt - einmalig anlegen:
    echo.
    echo      copy deploy\deploy.config.example.json deploy\deploy.config.json
    echo      notepad deploy\deploy.config.json
    echo.
    echo      Darin Host, Benutzer und SSH-Schluessel der VM eintragen.
    goto :ende
)

where powershell >nul 2>&1
if errorlevel 1 (
    echo  [x] powershell nicht gefunden.
    goto :ende
)

set ACTION=%1
if "%ACTION%"=="" set ACTION=deploy

set EXTRA_ARGS=%2 %3
if /i "%1"=="test-games" if /i "%2"=="logs" (
    set ACTION=test-games-logs
    set EXTRA_ARGS=%3
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\deploy.ps1" -Action %ACTION% %EXTRA_ARGS%
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
    echo  Beendet mit Fehler-Code %RC%
) else (
    echo  Fertig.
)

:ende
echo.
if "%KEEPOPEN%"=="1" pause
exit /b %RC%
