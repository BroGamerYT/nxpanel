#!/bin/bash
export DISPLAY=:42
export STEAM_COMPAT_CLIENT_INSTALL_PATH=/home/container/.steam/steam
export STEAM_COMPAT_DATA_PATH=/home/container/.steam/steam/steamapps/compatdata/2300320
export WINEPREFIX=/home/container/.steam/steam/steamapps/compatdata/2300320/pfx

echo "Querying current ActiveProcess:"
proton run reg query "HKCU\Software\Valve\Steam\ActiveProcess"

echo "Adding ActiveUser to ActiveProcess:"
proton run reg add "HKCU\Software\Valve\Steam\ActiveProcess" /v "ActiveUser" /t REG_DWORD /d 1309969678 /f

echo "Verifying:"
proton run reg query "HKCU\Software\Valve\Steam\ActiveProcess"
