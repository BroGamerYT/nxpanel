#!/bin/bash
export WINEPREFIX=/home/container/.steam/steam/steamapps/compatdata/2300320/pfx
export DISPLAY=:42
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
export VKD3D_FEATURE_LEVEL=12_0
export SteamAppId=2300320
export SteamGameId=2300320
cd /home/container/game
cp steam_api64.dll.bak steam_api64.dll
cp steam_api64.dll.bak x64/steam_api64.dll
/usr/local/bin/files/bin/wine x64/FarmingSimulator2025Game.exe -name FarmingSimulator2025 -profile "C:/users/steamuser/Documents/My Games/FarmingSimulator2025" -server
