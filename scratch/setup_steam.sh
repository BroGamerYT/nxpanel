#!/bin/bash
export WINEPREFIX=/home/container/.steam/steam/steamapps/compatdata/2300320/pfx
export DISPLAY=:42
cd /tmp
if [ ! -f SteamSetup.exe ]; then
    curl -sSL -o SteamSetup.exe "https://cdn.cloudflare.steamstatic.com/client/installer/SteamSetup.exe"
fi
echo "Downloaded SteamSetup.exe, size: $(ls -lh SteamSetup.exe | awk '{print $5}')"
