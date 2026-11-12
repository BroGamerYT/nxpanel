#!/usr/bin/env bash
# NexusCore-Dienst entfernen.
#
#   sudo bash deploy/linux/uninstall-core.sh                    # Dienst und Programm entfernen, Daten bleiben
#   sudo bash deploy/linux/uninstall-core.sh --remove-containers  # zusaetzlich alle Spiel-Container des Cores loeschen
#   sudo bash deploy/linux/uninstall-core.sh --purge             # zusaetzlich ALLE Daten (Server, Welten, Benutzer, Backups) loeschen
#
# Die Daten liegen in /var/lib/nexuscore. Ohne --purge bleiben sie unveraendert - eine neue Installation findet sie wieder.
set -euo pipefail

PURGE=0
CONTAINERS=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1; CONTAINERS=1 ;;
    --remove-containers) CONTAINERS=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $a" >&2; exit 2 ;;
  esac
done
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausfuehren." >&2; exit 1; }

if systemctl list-unit-files nexuscore.service >/dev/null 2>&1 && systemctl cat nexuscore >/dev/null 2>&1; then
  log "Dienst anhalten (der Core beendet die Spiele sauber, das kann bis zu drei Minuten dauern)"
  systemctl stop nexuscore || true
  systemctl disable nexuscore >/dev/null 2>&1 || true
fi
rm -f /etc/systemd/system/nexuscore.service
systemctl daemon-reload

if [ "$CONTAINERS" = 1 ] && command -v docker >/dev/null 2>&1; then
  # Nur Container mit dem Kennzeichen des Cores - nichts anderes auf diesem Rechner
  IDS="$(docker ps -aq --filter label=nexuscore.server 2>/dev/null || true) $(docker ps -aq --filter label=nexuscore.installer 2>/dev/null || true)"
  if [ -n "${IDS// /}" ]; then
    log "Spiel-Container entfernen"
    # shellcheck disable=SC2086
    docker rm -f $IDS >/dev/null
  fi
  docker network rm nexuscore-games >/dev/null 2>&1 || true
fi

log "Programm entfernen: /opt/nexuscore"
rm -rf /opt/nexuscore

if [ "$PURGE" = 1 ]; then
  log "ALLE Daten loeschen: /var/lib/nexuscore, /etc/nexuscore"
  rm -rf /var/lib/nexuscore /etc/nexuscore
  id nexuscore >/dev/null 2>&1 && userdel nexuscore || true
else
  echo "Daten bleiben: /var/lib/nexuscore (Server, Welten, Benutzer, Backups) und /etc/nexuscore (Einstellungen, Token)."
  echo "Komplett entfernen: erneut mit --purge ausfuehren."
fi
log "Fertig."
