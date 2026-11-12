#!/usr/bin/env bash
# Exportiert die Panel-Tabellen als JSON fuer die Datenuebernahme in den Core.
# Laeuft auf dem Rechner, auf dem das Panel (Docker, Container nxp-postgres) laeuft. Nur lesend.
#
#   ./export-panel.sh > panel-export.json
#
# Die Datei enthaelt Passwort-Hashes und verschluesselte Geheimnisse: wie ein Passwort behandeln, nach der Uebernahme loeschen.
set -euo pipefail
CONTAINER="${PANEL_POSTGRES_CONTAINER:-nxp-postgres}"
TABLES="users servers eggs allocations server_schedules subusers steam_accounts panel_settings passkeys sftp_passwords recovery_codes backups storage_targets nodes player_bans"
first=1
printf '{'
for t in $TABLES; do
  [ $first -eq 1 ] || printf ','
  first=0
  printf '"%s":' "$t"
  docker exec "$CONTAINER" sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -At -c \"select coalesce(json_agg(t), '[]'::json) from $t t\"" | tr -d '\n'
done
printf '}\n'
