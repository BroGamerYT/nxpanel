#!/bin/bash
export WINEPREFIX=/home/container/.steam/steam/steamapps/compatdata/2300320/pfx
export DISPLAY=:42
cd /home/container/game
/usr/local/bin/files/bin/wine x64/FarmingSimulator2025Game.exe -help 2>&1
