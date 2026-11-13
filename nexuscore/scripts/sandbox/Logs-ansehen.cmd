@echo off
rem Zeigt die Protokolle im Editor (Notepad).
if exist "C:\ProgramData\NexusCore\logs\core.log" start "" notepad.exe "C:\ProgramData\NexusCore\logs\core.log"
if exist "%~dp0install.log" start "" notepad.exe "%~dp0install.log"
if not exist "C:\ProgramData\NexusCore\logs\core.log" echo Noch kein core.log - ist NexusCore installiert und der Dienst gestartet?
pause
