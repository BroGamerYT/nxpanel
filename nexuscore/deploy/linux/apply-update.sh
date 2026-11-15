#!/usr/bin/env bash
# Spielt ein NexusCore-Update unter Linux ein. Laeuft als root und wird von nexuscore-update.path gestartet, sobald der Core
# (Benutzer nexuscore, ohne Root-Rechte) die Anforderungsdatei <Datenordner>/updates/request mit einem Release-Tag anlegt.
#
# Vertrauen: Der Core darf nur ANFORDERN. Dieses Skript prueft selbst
#   - der Tag hat die Form core-vX.Y.Z und ist neuer als die installierte Version (kein Zurueckstufen),
#   - Adresse und SHA-256-Pruefsumme des Pakets kommen direkt von GitHub (nicht vom Core),
#   - das Paket stimmt mit der Pruefsumme ueberein, sonst wird nichts installiert.
# Ergebnis und Protokoll liegen in root-eigenen Ordnern (/run/nexuscore-update, /var/log/nexuscore-update), die der Core nur liest;
# in Ordnern, die der Core beschreiben darf, legt dieses Skript nichts an. Schlaegt die Installation fehl oder startet die neue
# Version nicht, wird der alte Stand zurueckgespielt.
set -uo pipefail

ENV_FILE=/etc/nexuscore/nexuscore.env
APP_DIR=/opt/nexuscore
RUN_DIR=/run/nexuscore-update
LOG_DIR=/var/log/nexuscore-update
ASSET=NexusCore-linux.tar.gz

envval() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true; }

main() {
  local DATA_DIR REPO PORT REQ TAG VER LOG WORK CUR INFO URL DIGEST SUM i
  DATA_DIR="$(envval NEXUSCORE_DATA_DIR)"; DATA_DIR="${DATA_DIR:-/var/lib/nexuscore}"
  REPO="$(envval NEXUSCORE_UPDATE_REPO)"; REPO="${REPO:-BroGamerYT/nxpanel}"
  PORT="$(envval NEXUSCORE_PORT)"; PORT="${PORT:-8443}"
  [[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "Ungueltiges Repository: $REPO" >&2; return 1; }
  [[ "$DATA_DIR" == /* ]] || { echo "Ungueltiger Datenordner" >&2; return 1; }
  REQ="$DATA_DIR/updates/request"

  install -d -m 0755 "$RUN_DIR" "$LOG_DIR"
  [ -f "$REQ" ] && [ ! -L "$REQ" ] || { echo "Keine Anforderung."; return 0; }
  TAG="$(head -c 64 "$REQ" | tr -d '\r\n ')"
  rm -f "$REQ"   # zuerst entfernen: so startet ein Fehler keine Schleife

  result() { printf '%s\n%s\n' "$1" "${2:-}" > "$RUN_DIR/result.tmp" && mv -f "$RUN_DIR/result.tmp" "$RUN_DIR/result"; chmod 0644 "$RUN_DIR/result"; }
  log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }
  fail() { log "FEHLER: $*"; result failed "$*"; }

  if ! [[ "$TAG" =~ ^core-v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then LOG=/dev/null; echo "Ungueltiger Tag" >&2; result failed "Ungültiger Release-Tag in der Anforderung."; return 1; fi
  VER="${BASH_REMATCH[1]}"
  LOG="$LOG_DIR/install-$VER.log"
  rm -f "$LOG"; : > "$LOG"; chmod 0644 "$LOG"
  rm -f "$RUN_DIR/result"
  log "Update auf $VER angefordert (Repository $REPO)"

  CUR="$(cd "$APP_DIR" && node -p "require('./package.json').version" 2>/dev/null)"
  [ -n "$CUR" ] || { fail "Die installierte Version ist nicht lesbar."; return 1; }
  if [ "$CUR" = "$VER" ] || [ "$(printf '%s\n%s\n' "$CUR" "$VER" | sort -V | tail -1)" != "$VER" ]; then
    fail "Version $VER ist nicht neuer als die installierte ($CUR)."; return 1
  fi

  WORK="$(mktemp -d /var/tmp/nexuscore-update.XXXXXX)" || { fail "Kein Arbeitsordner."; return 1; }
  trap 'rm -rf "$WORK"' RETURN

  log "Frage GitHub nach $TAG"
  curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' -H 'User-Agent: NexusCore-Update' \
    "https://api.github.com/repos/$REPO/releases/tags/$TAG" -o "$WORK/release.json" 2>>"$LOG" || { fail "GitHub nicht erreichbar oder Release $TAG nicht gefunden."; return 1; }
  INFO="$(node -e '
    const [file, repo, tag, asset] = process.argv.slice(1);
    const r = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const a = (r.assets || []).find((x) => x.name === asset);
    const prefix = `https://github.com/${repo}/releases/download/${tag}/`;
    if (!a || typeof a.browser_download_url !== "string" || !a.browser_download_url.startsWith(prefix)) process.exit(2);
    const m = /^sha256:([0-9a-f]{64})$/i.exec(a.digest || "");
    if (!m) process.exit(3);
    console.log(a.browser_download_url + " " + m[1].toLowerCase());
  ' "$WORK/release.json" "$REPO" "$TAG" "$ASSET")"
  case $? in
    0) ;;
    2) fail "Im Release $TAG fehlt $ASSET."; return 1 ;;
    *) fail "GitHub nennt keine Prüfsumme für $ASSET - ohne sie wird nicht installiert."; return 1 ;;
  esac
  URL="${INFO%% *}"; DIGEST="${INFO##* }"

  log "Lade $URL"
  curl -fsSL --max-time 900 --max-filesize 400000000 -H 'User-Agent: NexusCore-Update' "$URL" -o "$WORK/pkg.tgz" 2>>"$LOG" || { fail "Download fehlgeschlagen."; return 1; }
  SUM="$(sha256sum "$WORK/pkg.tgz" | cut -d' ' -f1)"
  [ "$SUM" = "$DIGEST" ] || { fail "Die Prüfsumme des Pakets stimmt nicht - es wird nicht installiert."; return 1; }
  log "Prüfsumme stimmt."

  mkdir "$WORK/x" && tar -xzf "$WORK/pkg.tgz" --no-same-owner -C "$WORK/x" 2>>"$LOG" || { fail "Das Paket lässt sich nicht entpacken."; return 1; }
  [ "$(cat "$WORK/x/nexuscore-linux/VERSION" 2>/dev/null)" = "$VER" ] || { fail "Die Version im Paket passt nicht zu $VER."; return 1; }
  [ -f "$WORK/x/nexuscore-linux/nexuscore/deploy/linux/install-core.sh" ] || { fail "Das Paket enthält kein install-core.sh."; return 1; }

  log "Sichere den bisherigen Stand ($CUR)"
  rm -rf "$APP_DIR.prev"
  cp -a "$APP_DIR" "$APP_DIR.prev" 2>>"$LOG" || { rm -rf "$APP_DIR.prev"; fail "Sicherung des bisherigen Stands fehlgeschlagen."; return 1; }

  rollback() {
    log "Spiele den bisherigen Stand $CUR zurück"
    rm -rf "$APP_DIR"; mv "$APP_DIR.prev" "$APP_DIR"
    systemctl restart nexuscore >>"$LOG" 2>&1 || true
  }

  log "Installiere $VER (install-core.sh)"
  if ! bash "$WORK/x/nexuscore-linux/nexuscore/deploy/linux/install-core.sh" >>"$LOG" 2>&1; then
    rollback; fail "Die Installation ist fehlgeschlagen - der bisherige Stand $CUR läuft wieder."; return 1
  fi
  for i in $(seq 1 30); do
    if curl -fs --max-time 3 "http://127.0.0.1:$PORT/core/v1/info" 2>/dev/null | grep -q "\"version\":\"$VER\""; then
      rm -rf "$APP_DIR.prev"
      log "Fertig: NexusCore $VER läuft."
      result ok "$VER"
      return 0
    fi
    sleep 1
  done
  rollback; fail "Der Core $VER antwortet nicht - der bisherige Stand $CUR läuft wieder."; return 1
}

main "$@"
exit $?
