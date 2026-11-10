#!/bin/bash
DIR="/home/container/.steam/steam/steamapps/compatdata/2300320/pfx/drive_c/Program Files (x86)/Steam/logs"
ls -la "$DIR"
cat "$DIR/connection_log.txt" 2>/dev/null | tail -n 25
cat "$DIR/bootstrap_log.txt" 2>/dev/null | tail -n 25
