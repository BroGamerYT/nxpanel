#!/bin/bash
export WINEPREFIX=/home/container/.steam/steam/steamapps/compatdata/2300320/pfx
export DISPLAY=:42
cd /tmp
/usr/local/bin/files/bin/wine SteamSetup.exe /S
echo "Wine install finished with code: $?"
ls -la "$WINEPREFIX/drive_c/Program Files (x86)/Steam" 2>/dev/null || echo "Not in standard path"
