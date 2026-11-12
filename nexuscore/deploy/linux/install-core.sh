#!/usr/bin/env bash
# NexusCore als Systemdienst einrichten (Debian 12 / Ubuntu 22.04+, Docker-Treiber).
#
#   sudo bash deploy/linux/install-core.sh            # einrichten und starten
#   bash deploy/linux/install-core.sh --dry-run       # nur zeigen, was passieren wuerde (ohne root)
#
# Vorher im Ordner nexuscore:  npm ci && npm run build      und im Ordner web:  npm ci && npm run build
# Umgebungsvariablen: CORE_HOST (127.0.0.1), CORE_PORT (8443), PORT_RANGE (25565-25664), NO_START=1
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
APP_DIR=/opt/nexuscore
DATA_DIR=/var/lib/nexuscore
ENV_DIR=/etc/nexuscore
ENV_FILE="$ENV_DIR/nexuscore.env"
UNIT=/etc/systemd/system/nexuscore.service
CORE_HOST="${CORE_HOST:-127.0.0.1}"
CORE_PORT="${CORE_PORT:-8443}"
PORT_RANGE="${PORT_RANGE:-25565-25664}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '   (Probelauf) %s\n' "$*"; else "$@"; fi; }

[ "$DRY" = 1 ] && warn "Probelauf: es wird nichts veraendert."
[ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren (sudo bash $0)."
[ "$(uname -s)" = Linux ] || die "Dieses Skript ist fuer Linux."

# --- Voraussetzungen pruefen (nichts wird ungefragt aus dem Netz nachgeladen) ---------------------------
command -v node >/dev/null 2>&1 || die "Node.js fehlt. Version 22.13 oder neuer installieren (https://nodejs.org), dann erneut starten."
NODE_VER="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js $NODE_VER ist zu alt - gebraucht wird 22.13 oder neuer."
log "Node.js $NODE_VER"
command -v docker >/dev/null 2>&1 || die "Docker fehlt. Docker Engine installieren (https://docs.docker.com/engine/install/), dann erneut starten."
if [ "$DRY" = 0 ]; then docker info >/dev/null 2>&1 || die "Der Docker-Dienst antwortet nicht (laeuft 'systemctl status docker'?)."; fi
log "Docker $(docker --version 2>/dev/null | head -1)"
[ -f "$CORE_SRC/dist/index.js" ] || die "$CORE_SRC/dist/index.js fehlt - zuerst 'npm run build' im Ordner nexuscore."
[ -d "$REPO_SRC/eggs" ] || die "Der Ordner eggs fehlt neben nexuscore ($REPO_SRC/eggs)."
[ -d "$REPO_SRC/web/dist" ] || warn "web/dist fehlt: der Core laeuft, aber ohne Weboberflaeche (im Ordner web: npm ci && npm run build)."

# --- Benutzer und Ordner ---------------------------------------------------------------------------------
if ! id nexuscore >/dev/null 2>&1; then
  log "Systembenutzer 'nexuscore' anlegen"
  run useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --user-group nexuscore
fi
getent group docker >/dev/null 2>&1 || warn "Die Gruppe 'docker' gibt es nicht - Docker richtig installiert?"
run install -d -m 0755 "$APP_DIR"
run install -d -m 0750 -o nexuscore -g nexuscore "$DATA_DIR"
run install -d -m 0750 -o root -g nexuscore "$ENV_DIR"

# --- Dateien kopieren --------------------------------------------------------------------------------------
log "Dateien nach $APP_DIR kopieren"
run rm -rf "$APP_DIR/dist"
run cp -a "$CORE_SRC/dist" "$APP_DIR/dist"
run cp -a "$CORE_SRC/package.json" "$CORE_SRC/package-lock.json" "$APP_DIR/"
run rm -rf "$APP_DIR/eggs" "$APP_DIR/docs"
run cp -a "$REPO_SRC/eggs" "$APP_DIR/eggs"
# Dokumentation fuer die Hilfe-Seite der Oberflaeche
run cp -a "$CORE_SRC/docs" "$APP_DIR/docs"
# Kuratierter Katalog fuer die Suche nach Spielen (Admin -> Spiele -> Katalog)
[ -f "$REPO_SRC/docs/EGG-KATALOG.md" ] && run cp -a "$REPO_SRC/docs/EGG-KATALOG.md" "$APP_DIR/docs/EGG-KATALOG.md" || true
if [ -d "$REPO_SRC/web/dist" ]; then
  run rm -rf "$APP_DIR/web"
  run install -d "$APP_DIR/web"
  run cp -a "$REPO_SRC/web/dist" "$APP_DIR/web/dist"
fi
log "Abhaengigkeiten installieren (npm ci --omit=dev)"
if [ "$DRY" = 1 ]; then echo "   (Probelauf) (cd $APP_DIR && npm ci --omit=dev)"; else (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund); fi
run chown -R root:root "$APP_DIR"

# --- Einstellungen ---------------------------------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  log "Einstellungen bleiben unveraendert: $ENV_FILE"
else
  log "Einstellungen anlegen: $ENV_FILE (mit neuem Zugriffstoken)"
  TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if [ "$DRY" = 1 ]; then
    echo "   (Probelauf) $ENV_FILE schreiben (Modus 0640, Gruppe nexuscore)"
  else
    umask 027
    cat > "$ENV_FILE" <<EOF
# NexusCore - Einstellungen (alle moeglichen Werte: nexuscore/.env.example im Quellcode)
NEXUSCORE_MODE=production
NEXUSCORE_RUNTIME=docker
NEXUSCORE_HOST=$CORE_HOST
NEXUSCORE_PORT=$CORE_PORT
NEXUSCORE_DATA_DIR=$DATA_DIR
NEXUSCORE_TOKEN=$TOKEN
# Hauptschluessel fuer gespeicherte Zugangsdaten: getrennt vom Datenordner halten (Backups des Datenordners verraten dann nichts)
NEXUSCORE_SECRET_KEY=$(openssl rand -hex 32)
NEXUSCORE_PORT_RANGE=$PORT_RANGE
NEXUSCORE_ADMIN_USER=admin
NEXUSCORE_LOG_LEVEL=info
# Zusaetzliche Namen, unter denen der Core erreichbar sein darf (z. B. mein-server.example.org)
NEXUSCORE_ALLOWED_HOSTS=
TZ=$(cat /etc/timezone 2>/dev/null || echo Europe/Berlin)
EOF
    chown root:nexuscore "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
  fi
fi

# --- Dienst --------------------------------------------------------------------------------------------------------
log "systemd-Dienst einrichten"
run install -m 0644 "$HERE/nexuscore.service" "$UNIT"
run systemctl daemon-reload
if [ "${NO_START:-0}" = 1 ]; then
  run systemctl enable nexuscore
  log "Fertig (nicht gestartet). Starten mit: systemctl start nexuscore"
else
  run systemctl enable --now nexuscore
  if [ "$DRY" = 0 ]; then
    sleep 3
    systemctl is-active --quiet nexuscore || { journalctl -u nexuscore -n 30 --no-pager; die "Der Dienst laeuft nicht - Log siehe oben."; }
  fi
  log "Der Core laeuft: http://$CORE_HOST:$CORE_PORT"
fi
cat <<EOF

Naechste Schritte
  Status:        systemctl status nexuscore
  Log:           journalctl -u nexuscore -f
  Erstes Passwort der Weboberflaeche:   cat $DATA_DIR/ERSTES-PASSWORT.txt
  Zugriffstoken (fuer Skripte, Kopplung):  grep NEXUSCORE_TOKEN $ENV_FILE
  Kopplungs-PIN fuer das Panel:  curl -s -H "Authorization: Bearer <Token>" http://$CORE_HOST:$CORE_PORT/api/v1/admin/pairing
  Selbsttest:    NEXUSCORE_TOKEN=<Token> bash $CORE_SRC/scripts/smoke-test.sh
EOF
