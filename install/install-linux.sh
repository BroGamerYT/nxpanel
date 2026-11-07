#!/usr/bin/env bash
# NexusPanel - Installation auf Debian 12 / Ubuntu 22.04+
# Aufruf als root:  bash install-linux.sh
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/nxpanel}"
PANEL_PORT="${PANEL_PORT:-8080}"
PORT_RANGE="${PORT_RANGE:-25500-25600}"
TZ_VALUE="${TZ_VALUE:-Europe/Berlin}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren (sudo bash install-linux.sh)."

# --- System pruefen ---------------------------------------------------------
. /etc/os-release 2>/dev/null || die "Keine /etc/os-release gefunden."
case "$ID" in
  debian|ubuntu) ;;
  *) warn "Getestet auf Debian und Ubuntu, hier laeuft '$ID'. Weiter auf eigenes Risiko." ;;
esac

TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
log "Arbeitsspeicher: ${TOTAL_MB} MB"
[ "$TOTAL_MB" -lt 2000 ] && warn "Unter 2 GB RAM laeuft hoechstens das Panel selbst, kein Gameserver."

FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
log "Freier Speicher auf /: ${FREE_GB} GB"
[ "$FREE_GB" -lt 20 ] && warn "Unter 20 GB frei. Spieldaten und Backups brauchen deutlich mehr."

# --- Pakete -----------------------------------------------------------------
log "Grundpakete installieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl rsync tar zstd >/dev/null

# --- Docker -----------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker ist bereits vorhanden: $(docker --version)"
else
  log "Docker installieren"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
fi

docker info >/dev/null 2>&1 || die "Docker laeuft nicht. In einem LXC fehlt meist nesting=1 und keyctl=1."

# --- Verzeichnisse ----------------------------------------------------------
log "Verzeichnisse unter $INSTALL_DIR anlegen"
mkdir -p "$INSTALL_DIR" /var/lib/panel/volumes /var/lib/panel/backups
chmod 750 /var/lib/panel

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$SRC_DIR/deploy/docker-compose.yml" ]; then
  cp "$SRC_DIR/deploy/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
else
  die "deploy/docker-compose.yml nicht gefunden. Repo vollstaendig kopieren."
fi

# --- Konfiguration ----------------------------------------------------------
if [ -f "$INSTALL_DIR/.env" ]; then
  log "Vorhandene .env bleibt unveraendert"
else
  log "Geheimnisse erzeugen"
  cat > "$INSTALL_DIR/.env" <<ENVEOF
PANEL_IMAGE=${PANEL_IMAGE:-ghcr.io/brogameryt/nxpanel:latest}
PANEL_PORT=${PANEL_PORT}
PANEL_URL=http://$(hostname -I | awk '{print $1}'):${PANEL_PORT}
POSTGRES_DB=panel
POSTGRES_USER=panel
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
PORT_RANGE=${PORT_RANGE}
TZ=${TZ_VALUE}
ENVEOF
  chmod 600 "$INSTALL_DIR/.env"
fi

# --- Kernel-Einstellungen ---------------------------------------------------
log "Kernel-Einstellungen fuer viele Container setzen"
cat > /etc/sysctl.d/99-gameserver-panel.conf <<'SYSEOF'
# Gameserver brauchen viele offene Dateien und Watches
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 524288
fs.file-max = 2097152
net.core.somaxconn = 4096
vm.max_map_count = 262144
SYSEOF
sysctl -q --system || warn "sysctl konnte nicht angewendet werden (im LXC normal)."

# --- Firewall ---------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "ufw-Regeln setzen"
  ufw allow "${PANEL_PORT}/tcp" >/dev/null
  ufw allow "${PORT_RANGE//-/:}/tcp" >/dev/null
  ufw allow "${PORT_RANGE//-/:}/udp" >/dev/null
else
  warn "Keine aktive ufw gefunden. Ports ${PANEL_PORT} und ${PORT_RANGE} (TCP+UDP) selbst freigeben."
fi

# --- Start ------------------------------------------------------------------
cd "$INSTALL_DIR"
log "Container starten"
if ! docker compose pull 2>/dev/null; then
  warn "Panel-Image konnte nicht geladen werden."
  warn "PANEL_IMAGE in $INSTALL_DIR/.env eintragen und danach:"
  warn "  cd $INSTALL_DIR && docker compose up -d"
  log  "Postgres und Redis starten trotzdem."
  docker compose up -d postgres redis
else
  docker compose up -d
fi

# --- Dienst beim Systemstart ------------------------------------------------
cat > /etc/systemd/system/nxpanel.service <<SVCEOF
[Unit]
Description=NexusPanel
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable nxpanel.service >/dev/null 2>&1 || true

IP=$(hostname -I | awk '{print $1}')
echo
log "Fertig."
echo "  Panel:        http://${IP}:${PANEL_PORT}"
echo "  Verzeichnis:  ${INSTALL_DIR}"
echo "  Spieldaten:   /var/lib/panel/volumes"
echo "  Logs:         cd ${INSTALL_DIR} && docker compose logs -f panel"
echo
warn "Der Panel-Container hat Zugriff auf den Docker-Socket. Dieser Host gehoert niemandem sonst."
