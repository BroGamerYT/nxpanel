#!/usr/bin/env bash
# NexusPanel entfernen. Spieldaten bleiben erhalten, ausser --purge.
set -euo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/nxpanel}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausfuehren."; exit 1; }

if [ -d "$INSTALL_DIR" ]; then
  cd "$INSTALL_DIR"
  docker compose down || true
fi
systemctl disable --now nxpanel.service 2>/dev/null || true
rm -f /etc/systemd/system/nxpanel.service
systemctl daemon-reload 2>/dev/null || true

if [ "$PURGE" -eq 1 ]; then
  echo "ACHTUNG: Das loescht alle Spieldaten und Backups unter /var/lib/panel."
  read -r -p "Wirklich? Tippe LOESCHEN: " a
  [ "$a" = "LOESCHEN" ] || { echo "Abgebrochen."; exit 1; }
  docker volume rm nxpanel_pgdata nxpanel_redisdata nxpanel_paneldata 2>/dev/null || true
  rm -rf /var/lib/panel "$INSTALL_DIR"
  echo "Alles entfernt."
else
  echo "Panel gestoppt. Daten unter /var/lib/panel und $INSTALL_DIR sind noch da."
  echo "Vollstaendig entfernen: bash uninstall.sh --purge"
fi
