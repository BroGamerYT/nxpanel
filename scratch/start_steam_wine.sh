#!/bin/bash
export WINEPREFIX=/home/container/.steam/steam/steamapps/compatdata/2300320/pfx
export DISPLAY=:42
cd "/home/container/.steam/steam/steamapps/compatdata/2300320/pfx/drive_c/Program Files (x86)/Steam"
/usr/local/bin/files/bin/wine steam.exe -silent -no-browser -cef-disable-gpu -no-cef-sandbox +login ServerMoPs4ever > /tmp/steam_wine.log 2>&1 &
echo "Started Steam in Wine, PID: $!"
sleep 5
ps aux | grep -i steam
