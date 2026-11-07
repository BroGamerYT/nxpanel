#!/usr/bin/env bash
# NexusPanel - LXC-Container auf einem Proxmox-Host anlegen
# Auf dem Proxmox-Host als root ausfuehren:  bash proxmox-ct.sh
#
# Hinweis: Docker in einem LXC braucht nesting und keyctl. Das funktioniert,
# ist aber fehleranfaelliger als eine VM. Fuer die Gameserver selbst ist
# proxmox-vm.sh die bessere Wahl; dieser CT eignet sich gut fuer das Panel.
set -euo pipefail

CTID="${CTID:-}"
HOSTNAME_CT="${HOSTNAME_CT:-nxpanel}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DISK_GB="${DISK_GB:-32}"
RAM_MB="${RAM_MB:-4096}"
SWAP_MB="${SWAP_MB:-1024}"
CORES="${CORES:-4}"
BRIDGE="${BRIDGE:-vmbr0}"
IPCONF="${IPCONF:-dhcp}"          # z.B. 10.0.0.50/24 oder dhcp
GATEWAY="${GATEWAY:-}"
TEMPLATE_NAME="${TEMPLATE_NAME:-debian-12-standard}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v pct  >/dev/null || die "pct nicht gefunden. Dieses Skript laeuft auf dem Proxmox-Host."
command -v pvesh >/dev/null || die "pvesh nicht gefunden."
[ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren."

# --- ID bestimmen -----------------------------------------------------------
if [ -z "$CTID" ]; then
  CTID=$(pvesh get /cluster/nextid)
fi
pct status "$CTID" >/dev/null 2>&1 && die "CTID $CTID ist bereits vergeben."
log "Neuer Container: CTID $CTID, Hostname $HOSTNAME_CT"

# --- Template besorgen ------------------------------------------------------
log "Template suchen"
pveam update >/dev/null 2>&1 || warn "pveam update fehlgeschlagen, nutze lokalen Stand."
TEMPLATE=$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk -v n="$TEMPLATE_NAME" '$1 ~ n {print $1}' | sort | tail -1)
if [ -z "$TEMPLATE" ]; then
  AVAIL=$(pveam available --section system | awk -v n="$TEMPLATE_NAME" '$2 ~ n {print $2}' | sort | tail -1)
  [ -n "$AVAIL" ] || die "Kein Template fuer '$TEMPLATE_NAME' gefunden."
  log "Template herunterladen: $AVAIL"
  pveam download "$TEMPLATE_STORAGE" "$AVAIL"
  TEMPLATE="${TEMPLATE_STORAGE}:vztmpl/${AVAIL}"
fi
log "Template: $TEMPLATE"

# --- Passwort ---------------------------------------------------------------
ROOT_PW=$(openssl rand -base64 18)

# --- Netzwerk ---------------------------------------------------------------
NETCONF="name=eth0,bridge=${BRIDGE},ip=${IPCONF}"
[ -n "$GATEWAY" ] && NETCONF="${NETCONF},gw=${GATEWAY}"

# --- Container anlegen ------------------------------------------------------
log "Container anlegen"
pct create "$CTID" "$TEMPLATE" \
  --hostname "$HOSTNAME_CT" \
  --cores "$CORES" \
  --memory "$RAM_MB" \
  --swap "$SWAP_MB" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "$NETCONF" \
  --password "$ROOT_PW" \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --onboot 1 \
  --start 0 \
  --description "NexusPanel"

# Docker im unprivilegierten LXC braucht AppArmor-Freigaben
CONF="/etc/pve/lxc/${CTID}.conf"
{
  echo "lxc.apparmor.profile: unconfined"
  echo "lxc.cgroup2.devices.allow: a"
  echo "lxc.cap.drop:"
} >> "$CONF"
warn "Fuer Docker im LXC wurde AppArmor fuer diesen Container abgeschaltet."
warn "Das senkt die Isolation. Wer das nicht will, nimmt proxmox-vm.sh."

log "Container starten"
pct start "$CTID"
sleep 8

# --- Innen einrichten -------------------------------------------------------
log "Pakete im Container installieren"
pct exec "$CTID" -- bash -lc 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl ca-certificates openssl rsync >/dev/null'

log "Installer in den Container kopieren"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pct exec "$CTID" -- mkdir -p /root/nxpanel/deploy /root/nxpanel/install
pct push "$CTID" "$SRC_DIR/deploy/docker-compose.yml" /root/nxpanel/deploy/docker-compose.yml
pct push "$CTID" "$SRC_DIR/install/install-linux.sh"  /root/nxpanel/install/install-linux.sh

log "Panel im Container installieren"
pct exec "$CTID" -- bash -lc 'cd /root/nxpanel/install && bash install-linux.sh'

CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
echo
log "Fertig."
echo "  CTID:          $CTID"
echo "  Hostname:      $HOSTNAME_CT"
echo "  IP:            ${CT_IP:-per DHCP, siehe pct exec $CTID -- ip a}"
echo "  root-Passwort: $ROOT_PW"
echo "  Panel:         http://${CT_IP:-<ip>}:8080"
echo
warn "root-Passwort jetzt notieren, es wird nicht gespeichert."
