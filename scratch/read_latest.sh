LATEST=$(ls -t "/var/lib/panel/volumes/ca7b24f0/.steam/steam/steamapps/compatdata/2300320/pfx/drive_c/users/steamuser/Documents/My Games/FarmingSimulator2025/"log_*.txt | head -n 1)
echo "Latest: $LATEST"
tail -n 25 "$LATEST"
