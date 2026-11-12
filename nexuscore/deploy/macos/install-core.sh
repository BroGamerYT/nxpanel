#!/usr/bin/env bash
# NexusCore auf macOS einrichten (Docker Desktop, als Anmeldeobjekt/LaunchAgent des Benutzers).
#
#   bash deploy/macos/install-core.sh            # einrichten und starten (NICHT mit sudo)
#   bash deploy/macos/install-core.sh --dry-run  # nur zeigen, was passieren wuerde
#
# Vorher:  npm ci && npm run build   (Ordner nexuscore)   und   npm ci && npm run build   (Ordner web)
# Docker Desktop muss installiert sein und laufen (https://docs.docker.com/desktop/setup/install/mac-install/).
# Warum ein LaunchAgent und kein Systemdienst: Docker Desktop laeuft im Benutzerkonto, nicht systemweit.
# Hinweis: auf macOS ist dieser Weg bisher NICHT auf einem echten Mac getestet.
set -euo pipefail

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $a" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SRC="$(cd "$HERE/../.." && pwd)"
REPO_SRC="$(cd "$CORE_SRC/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/NexusCore"
APP_DIR="$SUPPORT/app"
DATA_DIR="$SUPPORT/data"
ENV_FILE="$SUPPORT/nexuscore.env"
LOG_DIR="$HOME/Library/Logs/NexusCore"
LABEL="de.nexuscore.core"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CORE_HOST="${CORE_HOST:-127.0.0.1}"
CORE_PORT="${CORE_PORT:-8443}"
PORT_RANGE="${PORT_RANGE:-25565-25664}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '   (Probelauf) %s\n' "$*"; else "$@"; fi; }

[ "$DRY" = 1 ] && warn "Probelauf: es wird nichts veraendert."
[ "$DRY" = 1 ] || [ "$(uname -s)" = Darwin ] || die "Dieses Skript ist fuer macOS."
[ "$(id -u)" -ne 0 ] || die "Nicht mit sudo ausfuehren: der Core muss im Benutzerkonto laufen (dort laeuft Docker Desktop)."

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js fehlt. Version 22.13 oder neuer installieren (https://nodejs.org), dann erneut starten."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js $(node -p 'process.versions.node') ist zu alt - gebraucht wird 22.13 oder neuer."
command -v docker >/dev/null 2>&1 || die "Docker fehlt. Docker Desktop installieren und starten."
if [ "$DRY" = 0 ]; then docker info >/dev/null 2>&1 || die "Docker Desktop antwortet nicht - bitte starten und erneut versuchen."; fi
[ -f "$CORE_SRC/dist/index.js" ] || die "$CORE_SRC/dist/index.js fehlt - zuerst 'npm run build' im Ordner nexuscore."
[ -d "$REPO_SRC/eggs" ] || die "Der Ordner eggs fehlt ($REPO_SRC/eggs)."
[ -d "$REPO_SRC/web/dist" ] || warn "web/dist fehlt: der Core laeuft, aber ohne Weboberflaeche."

log "Dateien nach $APP_DIR kopieren"
run mkdir -p "$APP_DIR" "$DATA_DIR" "$LOG_DIR" "$(dirname "$PLIST")"
run rm -rf "$APP_DIR/dist" "$APP_DIR/eggs" "$APP_DIR/web"
run cp -R "$CORE_SRC/dist" "$APP_DIR/dist"
run cp "$CORE_SRC/package.json" "$CORE_SRC/package-lock.json" "$APP_DIR/"
run cp -R "$REPO_SRC/eggs" "$APP_DIR/eggs"
if [ -d "$REPO_SRC/web/dist" ]; then run mkdir -p "$APP_DIR/web"; run cp -R "$REPO_SRC/web/dist" "$APP_DIR/web/dist"; fi
if [ "$DRY" = 1 ]; then echo "   (Probelauf) (cd '$APP_DIR' && npm ci --omit=dev)"; else (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund); fi

if [ -f "$ENV_FILE" ]; then
  log "Einstellungen bleiben unveraendert: $ENV_FILE"
else
  log "Einstellungen anlegen: $ENV_FILE (mit neuem Zugriffstoken)"
  TOKEN="$(openssl rand -hex 32)"
  if [ "$DRY" = 1 ]; then echo "   (Probelauf) $ENV_FILE schreiben (Modus 0600)"; else
    umask 077
    cat > "$ENV_FILE" <<EOF
NEXUSCORE_MODE=production
NEXUSCORE_RUNTIME=docker
NEXUSCORE_HOST=$CORE_HOST
NEXUSCORE_PORT=$CORE_PORT
NEXUSCORE_DATA_DIR=$DATA_DIR
NEXUSCORE_TOKEN=$TOKEN
NEXUSCORE_PORT_RANGE=$PORT_RANGE
NEXUSCORE_ADMIN_USER=admin
NEXUSCORE_LOG_LEVEL=info
NEXUSCORE_ALLOWED_HOSTS=
EOF
  fi
fi

# Startskript: liest die Einstellungen, findet den Docker-Socket von Docker Desktop und startet den Core
RUNNER="$SUPPORT/run-core.sh"
if [ "$DRY" = 1 ]; then echo "   (Probelauf) $RUNNER schreiben"; else
  cat > "$RUNNER" <<EOF
#!/bin/bash
set -a
. "$ENV_FILE"
set +a
# Docker Desktop legt den Socket im Benutzerordner an, wenn der systemweite Link fehlt
if [ ! -S /var/run/docker.sock ] && [ -S "\$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://\$HOME/.docker/run/docker.sock"
fi
cd "$APP_DIR"
exec "$NODE" dist/index.js
EOF
  chmod 0755 "$RUNNER"
fi

log "LaunchAgent einrichten: $PLIST"
if [ "$DRY" = 1 ]; then echo "   (Probelauf) $PLIST schreiben"; else
  sed -e "s#@RUNNER@#$RUNNER#g" -e "s#@LOG@#$LOG_DIR/core.log#g" -e "s#@WORKDIR@#$APP_DIR#g" "$HERE/de.nexuscore.core.plist" > "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
fi
if [ "${NO_START:-0}" = 1 ]; then
  log "Fertig (nicht gestartet). Starten: launchctl bootstrap gui/$(id -u) '$PLIST'"
else
  run launchctl bootstrap "gui/$(id -u)" "$PLIST"
  log "Der Core laeuft: http://$CORE_HOST:$CORE_PORT"
fi
cat <<EOF

Naechste Schritte
  Status:   launchctl print gui/$(id -u)/$LABEL | head
  Log:      tail -f "$LOG_DIR/core.log"
  Passwort der Weboberflaeche:  cat "$DATA_DIR/ERSTES-PASSWORT.txt"
  Token:    grep NEXUSCORE_TOKEN "$ENV_FILE"
  Selbsttest: NEXUSCORE_TOKEN=<Token> bash $CORE_SRC/scripts/smoke-test.sh
  Entfernen: bash $HERE/uninstall-core.sh
EOF
