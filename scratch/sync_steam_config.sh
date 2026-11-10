#!/bin/bash
PFX_STEAM="/home/container/.steam/steam/steamapps/compatdata/2300320/pfx/drive_c/Program Files (x86)/Steam"
mkdir -p "$PFX_STEAM/config" "$PFX_STEAM/userdata"
cp -r /home/container/.steam/steam/config/* "$PFX_STEAM/config/" 2>/dev/null
cp -r /home/container/.steam/steam/userdata/* "$PFX_STEAM/userdata/" 2>/dev/null
echo "Copied config and userdata to Wine Steam directory:"
ls -la "$PFX_STEAM/config"
