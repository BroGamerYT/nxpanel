#!/bin/bash
export WINEPREFIX=/home/container/.steam/steam/steamapps/compatdata/2300320/pfx
export DISPLAY=:42
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
export VKD3D_FEATURE_LEVEL=12_0
export WINEDEBUG=warn+all,err+all
cd /home/container/game
/usr/local/bin/files/bin/wine x64/FarmingSimulator2025Game.exe -name FarmingSimulator2025 -profile "C:/users/steamuser/Documents/My Games/FarmingSimulator2025" -server 2>&1 | tail -n 40
