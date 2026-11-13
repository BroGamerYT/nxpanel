@echo off
rem Kopiert die Protokolle in diesen Ordner - er liegt auch auf dem PC (%USERPROFILE%\sbx-nexuscore).
if exist "C:\ProgramData\NexusCore\logs\core.log" copy /y "C:\ProgramData\NexusCore\logs\core.log" "%~dp0core.log"
echo Fertig. install.log und core.log liegen jetzt in diesem Ordner.
pause
