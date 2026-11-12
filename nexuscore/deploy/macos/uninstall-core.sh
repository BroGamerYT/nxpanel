#!/usr/bin/env bash
# NexusCore auf macOS entfernen.
#
#   bash deploy/macos/uninstall-core.sh                     # Dienst und Programm entfernen, Daten bleiben
#   bash deploy/macos/uninstall-core.sh --remove-containers   # zusaetzlich die Spiel-Container des Cores loeschen
#   bash deploy/macos/uninstall-core.sh --purge              # zusaetzlich ALLE Daten (Server, Welten, Benutzer, Backups) loeschen
set -euo pipefail

PURGE=0; CONTAINERS=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1; CONTAINERS=1 ;;
    --remove-containers) CONTAINERS=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $a" >&2; exit 2 ;;
  esac
done
SUPPORT="$HOME/Library/Application Support/NexusCore"
LABEL="de.nexuscore.core"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

log "Dienst anhalten (der Core beendet die Spiele sauber, das kann bis zu drei Minuten dauern)"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

if [ "$CONTAINERS" = 1 ] && command -v docker >/dev/null 2>&1; then
  IDS="$(docker ps -aq --filter label=nexuscore.server 2>/dev/null || true) $(docker ps -aq --filter label=nexuscore.installer 2>/dev/null || true)"
  if [ -n "${IDS// /}" ]; then
    log "Spiel-Container entfernen"
    # shellcheck disable=SC2086
    docker rm -f $IDS >/dev/null
  fi
  docker network rm nexuscore-games >/dev/null 2>&1 || true
fi

rm -rf "$SUPPORT/app" "$SUPPORT/run-core.sh"
if [ "$PURGE" = 1 ]; then
  log "ALLE Daten loeschen: $SUPPORT"
  rm -rf "$SUPPORT" "$HOME/Library/Logs/NexusCore"
else
  echo "Daten und Einstellungen bleiben in: $SUPPORT (komplett entfernen: --purge)"
fi
log "Fertig."
