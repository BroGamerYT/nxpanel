@echo off
rem ============================================================================
rem  NexusCore in der Windows-Sandbox testen
rem  Doppelklick genuegt. Die Sandbox startet mit dem Installer (mit Installations-Protokoll)
rem  und dem Editor (Notepad). Alles, was du in den Ordner "NexusCore-Test" auf dem Sandbox-Desktop legst
rem  oder dort speicherst, liegt auch auf diesem PC in  %USERPROFILE%\sbx-nexuscore
rem ============================================================================
setlocal
set "HERE=%~dp0"
set "MSI=%HERE%..\dist\NexusCore-Setup.msi"
set "STAGE=%USERPROFILE%\sbx-nexuscore"
set "WSB=%TEMP%\nexuscore-test.wsb"

if not exist "%MSI%" (
  echo Der Installer fehlt: %MSI%
  echo Zuerst bauen:  pwsh nexuscore\scripts\build-windows-package.ps1
  pause
  exit /b 1
)

where WindowsSandbox.exe >nul 2>&1
if errorlevel 1 (
  echo Die Windows-Sandbox ist nicht aktiviert. In "Windows-Features" einschalten, dann neu starten.
  pause
  exit /b 1
)

rem Ordner neu anlegen - einfacher Pfad ohne Leerzeichen, nur dort wird gemappt
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
copy /y "%MSI%" "%STAGE%\NexusCore-Setup.msi" >nul
copy /y "%HERE%sandbox\start.cmd" "%STAGE%\start.cmd" >nul
copy /y "%HERE%sandbox\Logs-ansehen.cmd" "%STAGE%\Logs-ansehen.cmd" >nul
copy /y "%HERE%sandbox\Logs-kopieren.cmd" "%STAGE%\Logs-kopieren.cmd" >nul

> "%WSB%" echo ^<Configuration^>
>> "%WSB%" echo   ^<Networking^>Enable^</Networking^>
>> "%WSB%" echo   ^<MemoryInMB^>4096^</MemoryInMB^>
>> "%WSB%" echo   ^<MappedFolders^>
>> "%WSB%" echo     ^<MappedFolder^>
>> "%WSB%" echo       ^<HostFolder^>%STAGE%^</HostFolder^>
>> "%WSB%" echo       ^<SandboxFolder^>C:\Users\WDAGUtilityAccount\Desktop\NexusCore-Test^</SandboxFolder^>
>> "%WSB%" echo       ^<ReadOnly^>false^</ReadOnly^>
>> "%WSB%" echo     ^</MappedFolder^>
>> "%WSB%" echo   ^</MappedFolders^>
>> "%WSB%" echo   ^<LogonCommand^>
>> "%WSB%" echo     ^<Command^>C:\Users\WDAGUtilityAccount\Desktop\NexusCore-Test\start.cmd^</Command^>
>> "%WSB%" echo   ^</LogonCommand^>
>> "%WSB%" echo ^</Configuration^>

echo Starte die Windows-Sandbox ...
echo (Es darf nur eine Sandbox gleichzeitig laufen - eine offene bitte vorher schliessen.)
start "" "%WSB%"
endlocal
