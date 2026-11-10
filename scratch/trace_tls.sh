#!/bin/bash
cd /home/container/game/x64
export DISPLAY=:42
export STEAM_COMPAT_CLIENT_INSTALL_PATH=/home/container/.steam/steam
export STEAM_COMPAT_DATA_PATH=/home/container/.steam/steam/steamapps/compatdata/2300320
export WINEPREFIX=/home/container/.steam/steam/steamapps/compatdata/2300320/pfx
export WINEDEBUG=+secur32,+crypt

proton run ./FarmingSimulator2025Game.exe -profile "C:/users/steamuser/Documents/My Games/FarmingSimulator2025" -server -name FarmingSimulator2025 2>&1 | grep -iE 'secur32|crypt|gnutls|handshake|error|fail' | head -n 60
