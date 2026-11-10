#!/bin/bash
cd /home/container/game
cp steam_api64.dll.bak steam_api64.dll
cp steam_api64.dll.bak x64/steam_api64.dll
export STEAM_COMPAT_CLIENT_INSTALL_PATH="/home/container/.steam/steam"
export STEAM_COMPAT_DATA_PATH="/home/container/.steam/steam/steamapps/compatdata/2300320"
export SteamAppId=2300320
export SteamGameId=2300320
export SRCDS_APPID=2300320
export DISPLAY=:42
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
export VKD3D_FEATURE_LEVEL=12_0
proton run x64/FarmingSimulator2025Game.exe -name FarmingSimulator2025 -profile "C:/users/steamuser/Documents/My Games/FarmingSimulator2025" -server
