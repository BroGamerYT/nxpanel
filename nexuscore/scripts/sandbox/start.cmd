@echo off
rem Laeuft in der Sandbox beim Start: Ordner oeffnen, Installer mit Protokoll starten, Editor bereitstellen.
set "SHARE=%~dp0"
start "" explorer.exe "%SHARE%"
rem Der Installer schreibt ein Protokoll mit Zeitstempeln nach install.log (im Ordner NexusCore-Test)
start "" msiexec.exe /i "%SHARE%NexusCore-Setup.msi" /l*v "%SHARE%install.log"
rem Der Editor: Notepad
start "" notepad.exe
