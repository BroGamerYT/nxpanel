#!/bin/bash
DIR="/home/container/.steam/steam/steamapps/compatdata/2300320/pfx/drive_c/users/steamuser/Documents/My Games/FarmingSimulator2025"
ls -lt "$DIR" | head -n 5
LATEST=$(ls -t "$DIR"/log* 2>/dev/null | head -n 1)
if [ -n "$LATEST" ]; then
    echo "=== $LATEST ==="
    tail -n 25 "$LATEST"
fi
