#!/usr/bin/env bash
# NexusPanel - VM auf einem Proxmox-Host anlegen (empfohlener Weg)
# Auf dem Proxmox-Host als root ausfuehren:  bash proxmox-vm.sh
#
# Legt eine Debian-12-VM aus dem Cloud-Image an, richtet cloud-init ein und
# installiert Docker samt Panel beim ersten Start.
#
# Vorgabe: 48 GB RAM, 12 Kerne. Das passt auf einen 128-GB-Host, auf dem die
# bestehende AMP-VM 60 GB belegt und dem Wirtssystem rund 8 GB bleiben.
# Kein Ballooning: Gameserver reservieren ihren Speicher fest, dynamischer
# RAM fuehrt hier zu Abstuerzen statt zu Ersparnis (--balloon 0 ist gesetzt).
set -euo pipefail

VMID="${VMID:-}"
VMNAME="${VMNAME:-nxpanel}"
STORAGE="${STORAGE:-local-lvm}"
DISK_GB="${DISK_GB:-200}"
RAM_MB="${RAM_MB:-49152}"
CORES="${CORES:-12}"
BRIDGE="${BRIDGE:-vmbr0}"
IPCONF="${IPCONF:-dhcp}"          # z.B. ip=10.0.0.51/24,gw=10.0.0.1
SSH_KEY="${SSH_KEY:-/root/.ssh/id_rsa.pub}"
IMG_URL="${IMG_URL:-https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2}"
IMG_PATH="/var/lib/vz/template/iso/debian-12-genericcloud-amd64.qcow2"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v qm >/dev/null || die "qm nicht gefunden. Dieses Skript laeuft auf dem Proxmox-Host."
[ "$(id -u)" -eq 0 ] || die "Bitte als root ausfuehren."

[ -z "$VMID" ] && VMID=$(pvesh get /cluster/nextid)
qm status "$VMID" >/dev/null 2>&1 && die "VMID $VMID ist bereits vergeben."

# --- Cloud-Image ------------------------------------------------------------
if [ ! -f "$IMG_PATH" ]; then
  log "Cloud-Image herunterladen"
  curl -fL --progress-bar "$IMG_URL" -o "$IMG_PATH"
else
  log "Cloud-Image ist vorhanden"
fi

# --- cloud-init-Skript ------------------------------------------------------
SNIPPET_DIR="/var/lib/vz/snippets"
mkdir -p "$SNIPPET_DIR"
cat > "${SNIPPET_DIR}/nxp-${VMID}.yml" <<'CIEOF'
#cloud-config
package_update: true
packages: [curl, ca-certificates, openssl, rsync, zstd]
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - mkdir -p /opt/gameserver-panel
  - echo "Docker bereit. install-linux.sh aus dem Projektordner uebertragen und ausfuehren." > /root/NAECHSTER-SCHRITT.txt
CIEOF

# --- VM anlegen -------------------------------------------------------------
log "VM anlegen: VMID $VMID, $VMNAME"
qm create "$VMID" \
  --name "$VMNAME" \
  --cores "$CORES" \
  --cpu host \
  --memory "$RAM_MB" \
  --balloon 0 \
  --net0 "virtio,bridge=${BRIDGE}" \
  --scsihw virtio-scsi-single \
  --ostype l26 \
  --agent enabled=1 \
  --onboot 1 \
  --description "NexusPanel Docker-Host"

log "Datentraeger importieren"
qm importdisk "$VMID" "$IMG_PATH" "$STORAGE" >/dev/null
qm set "$VMID" --scsi0 "${STORAGE}:vm-${VMID}-disk-0,discard=on,ssd=1" >/dev/null
qm disk resize "$VMID" scsi0 "${DISK_GB}G" >/dev/null
qm set "$VMID" --ide2 "${STORAGE}:cloudinit" --boot order=scsi0 --serial0 socket --vga serial0 >/dev/null
qm set "$VMID" --ipconfig0 "${IPCONF}" >/dev/null
qm set "$VMID" --cicustom "user=local:snippets/nxp-${VMID}.yml" >/dev/null
[ -f "$SSH_KEY" ] && qm set "$VMID" --sshkeys "$SSH_KEY" >/dev/null || warn "Kein SSH-Key unter $SSH_KEY. Zugang spaeter ueber die Konsole."

log "VM starten"
qm start "$VMID"

echo
log "Fertig. Die VM richtet Docker beim ersten Start selbst ein (ein bis zwei Minuten)."
echo "  VMID:   $VMID"
echo "  Name:   $VMNAME"
echo "  Konsole: qm terminal $VMID"
echo
echo "Danach im Gast:"
echo "  1. Projektordner uebertragen (scp oder git clone)"
echo "  2. sudo bash install/install-linux.sh"
