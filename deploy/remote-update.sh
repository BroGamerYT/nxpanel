#!/usr/bin/env bash
# Laeuft AUF DER VM. Wird vom Updater hochgeladen und dort ausgefuehrt.
# Nicht von Hand aufrufen - dafuer ist deploy.bat da.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nxpanel}"
RELEASE_TGZ="${1:?Pfad zum hochgeladenen Archiv fehlt}"
KEEP_RELEASES=5

T0=$(date +%s)
# Mit Sekunden seit Start, damit man sieht, welcher Schritt dauert
log()  { printf '\033[1;34m[%s +%ss]\033[0m %s\n' "$(date +%H:%M:%S)" "$(( $(date +%s) - T0 ))" "$*"; }
warn() { printf '\033[1;33m[%s] [!]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { printf '\033[1;31m[%s] [x]\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren."
command -v docker >/dev/null || die "Docker fehlt. Erst install-linux.sh ausfuehren."

# Compose braucht beides ausdruecklich:
#   --env-file  weil es die .env sonst neben der Compose-Datei sucht
#               (also in deploy/), nicht im Wurzelverzeichnis der Fassung
#   -p nxpanel  weil der Projektname sonst vom Verzeichnisnamen kommt.
#               Jede Fassung liegt in einem eigenen Ordner mit Zeitstempel -
#               ohne festen Namen bekaeme jedes Update eigene Volumes und
#               damit eine leere Datenbank.
COMPOSE_PROJECT=nxpanel

STAMP=$(date +%Y%m%d-%H%M%S)
RELEASES="$APP_DIR/releases"
CURRENT="$APP_DIR/current"
mkdir -p "$RELEASES"

# --- 1. Neue Fassung auspacken -----------------------------------------
NEW="$RELEASES/$STAMP"
log "Neue Fassung auspacken nach $NEW"
mkdir -p "$NEW"
tar xzf "$RELEASE_TGZ" -C "$NEW"

# --- 2. Konfiguration und Daten uebernehmen ----------------------------
# Die .env bleibt IMMER auf dem Server. Sie wird nie mit hochgeladen und
# nie ueberschrieben - sonst waeren nach jedem Update alle Geheimnisse neu
# und die Datenbank unerreichbar.
if [ -f "$APP_DIR/.env" ]; then
  ln -sf "$APP_DIR/.env" "$NEW/.env"
  log "Vorhandene .env eingebunden"
elif [ -f "$CURRENT/.env" ]; then
  cp "$(readlink -f "$CURRENT/.env")" "$APP_DIR/.env"
  ln -sf "$APP_DIR/.env" "$NEW/.env"
  log ".env aus der laufenden Fassung uebernommen"
else
  # Erstinstallation: keine .env da, also die Umgebung hier einrichten.
  # Das Archiv bringt install-linux.sh mit - genau dafuer.
  if [ -x "$NEW/install/install-linux.sh" ] || [ -f "$NEW/install/install-linux.sh" ]; then
    warn "Keine .env gefunden - das sieht nach der ersten Installation aus."
    log "Richte die Umgebung ein (Docker, Verzeichnisse, Geheimnisse)"
    if ! INSTALL_DIR="$APP_DIR" bash "$NEW/install/install-linux.sh"; then
      rm -rf "$NEW"
      die "Erstinstallation fehlgeschlagen."
    fi
    [ -f "$APP_DIR/.env" ] || { rm -rf "$NEW"; die "Erstinstallation hat keine .env erzeugt."; }
    ln -sf "$APP_DIR/.env" "$NEW/.env"
    log "Umgebung eingerichtet"
  else
    rm -rf "$NEW"
    die "Keine .env und kein install-linux.sh im Archiv."
  fi
fi

# --- 3. Vorherige Fassung merken ---------------------------------------
PREVIOUS=""
if [ -L "$CURRENT" ]; then
  PREVIOUS=$(readlink -f "$CURRENT")
  log "Bisherige Fassung: $(basename "$PREVIOUS")"
fi

# --- 4. Image bauen ----------------------------------------------------
cd "$NEW"
log "Image bauen (das dauert beim ersten Mal)"
export DOCKER_BUILDKIT=1
if ! docker compose -p "$COMPOSE_PROJECT" --env-file "$APP_DIR/.env" \
       -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml build panel; then
  warn "Build fehlgeschlagen - die laufende Fassung bleibt unangetastet"
  rm -rf "$NEW"
  exit 1
fi

# --- 5. Umschalten -----------------------------------------------------
log "Auf die neue Fassung umschalten"
ln -sfn "$NEW" "$CURRENT"

cd "$CURRENT"
docker compose -p "$COMPOSE_PROJECT" --env-file "$APP_DIR/.env" \
  -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml up -d

# --- 6. Pruefen --------------------------------------------------------
PORT=$(grep -E '^PANEL_PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d '\r' || echo 8080)
PORT=${PORT:-8080}

log "Warte auf Bereitschaft (bis 90 s)"
OK=0
for i in $(seq 1 180); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then OK=1; break; fi
  sleep 0.5
done

if [ "$OK" -ne 1 ]; then
  warn "Panel antwortet nicht. Letzte Logzeilen:"
  docker compose -p "$COMPOSE_PROJECT" --env-file "$APP_DIR/.env" \
    -f deploy/docker-compose.yml logs --tail=40 panel || true

  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    warn "Rollback auf $(basename "$PREVIOUS")"
    ln -sfn "$PREVIOUS" "$CURRENT"
    cd "$CURRENT"
    docker compose -p "$COMPOSE_PROJECT" --env-file "$APP_DIR/.env" \
      -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml up -d
    die "Update fehlgeschlagen, alte Fassung laeuft wieder."
  fi
  die "Update fehlgeschlagen und kein Rollback moeglich."
fi

READY=$(curl -fsS "http://127.0.0.1:${PORT}/readyz" 2>/dev/null || echo '{}')
log "Bereit: $READY"

# --- 7. Aufraeumen -----------------------------------------------------
cd "$RELEASES"
COUNT=$(ls -1 | wc -l)
if [ "$COUNT" -gt "$KEEP_RELEASES" ]; then
  ls -1t | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
    [ "$RELEASES/$old" = "$(readlink -f "$CURRENT")" ] && continue
    log "Alte Fassung entfernen: $old"
    rm -rf "${RELEASES:?}/$old"
  done
fi
rm -f "$RELEASE_TGZ"

log "Fertig. Laufende Fassung: $STAMP"
