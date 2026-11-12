#!/usr/bin/env bash
# Selbsttest eines laufenden NexusCore mit Docker-Treiber: legt einen Minecraft-Server an, startet ihn, schickt einen
# Befehl, stoppt ihn und loescht ihn wieder. Zeigt je Schritt OK oder FEHLER.
#
#   NEXUSCORE_TOKEN=<Token> bash scripts/smoke-test.sh
#   BASE_URL=http://127.0.0.1:8443 NEXUSCORE_TOKEN=<Token> KEEP=1 bash scripts/smoke-test.sh   # Server nicht loeschen
#
# Das erste Mal dauert es, weil Docker das Image (itzg/minecraft-server, ca. 400 MB) laden muss: WAIT_START=600
set -uo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8443}"
TOKEN="${NEXUSCORE_TOKEN:-}"
WAIT_START="${WAIT_START:-600}"
KEEP="${KEEP:-0}"
[ -n "$TOKEN" ] || { echo "NEXUSCORE_TOKEN fehlt (steht in /etc/nexuscore/nexuscore.env)." >&2; exit 2; }
command -v curl >/dev/null || { echo "curl fehlt." >&2; exit 2; }
command -v node >/dev/null || { echo "node fehlt (wird zum Lesen der Antworten gebraucht)." >&2; exit 2; }

FAILS=0
ok()   { printf '  \033[1;32mOK\033[0m      %s\n' "$*"; }
bad()  { printf '  \033[1;31mFEHLER\033[0m  %s\n' "$*"; FAILS=$((FAILS + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

api() { # api METHOD PATH [JSON]   -> setzt $BODY (Antwort) und $CODE (HTTP) - nie in $(...) aufrufen, sonst gehen sie verloren
  local method="$1" path="$2" body="${3:-}"
  local out
  if [ -n "$body" ]; then
    out="$(curl -sS -m 30 -w '\n%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" "$BASE_URL$path" 2>&1)"
  elif [ "$method" = GET ]; then
    out="$(curl -sS -m 30 -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL$path" 2>&1)"
  else
    out="$(curl -sS -m 30 -w '\n%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE_URL$path" 2>&1)"
  fi
  CODE="$(printf '%s' "$out" | tail -n1)"
  BODY="$(printf '%s' "$out" | sed '$d')"
}
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split(".")){v=v?.[k]}console.log(v===undefined||v===null?"":v)}catch{console.log("")}})' "$1"; }

step "1. Core erreichbar"
INFO="$(curl -sS -m 10 "$BASE_URL/core/v1/info" 2>&1)" && ok "/core/v1/info: $(printf '%s' "$INFO" | jget core.version) auf $(printf '%s' "$INFO" | jget host.platform)" || { bad "Core antwortet nicht unter $BASE_URL ($INFO)"; exit 1; }
RT="$(printf '%s' "$INFO" | jget core.runtime)"; [ "$RT" = docker ] && ok "Treiber: docker" || bad "Treiber ist '$RT', erwartet 'docker' (NEXUSCORE_RUNTIME)"

step "2. Anmeldung"
CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE_URL/api/v1/servers")"; [ "$CODE" = 401 ] && ok "ohne Token: 401" || bad "ohne Token kam $CODE statt 401"
api GET /api/v1/servers >/dev/null; [ "$CODE" = 200 ] && ok "mit Token: 200" || { bad "mit Token kam $CODE (stimmt das Token?)"; exit 1; }

step "3. Docker erreichbar"
if command -v docker >/dev/null; then docker info >/dev/null 2>&1 && ok "docker info" || bad "docker info schlaegt fehl (laeuft der Dienst, darf dieser Benutzer ihn nutzen?)"; else bad "docker nicht gefunden"; fi

step "4. Server anlegen (Minecraft Paper, 2 GB)"
NAME="smoke-$(date +%H%M%S)"
api POST /api/v1/servers "{\"name\":\"$NAME\",\"eggId\":\"minecraft-paper\",\"ramMb\":2048,\"variables\":{\"EULA\":\"TRUE\",\"TYPE\":\"PAPER\"}}"
RES="$BODY"
ID="$(printf '%s' "$RES" | jget server.id)"
[ "$CODE" = 201 ] && [ -n "$ID" ] && ok "angelegt: $ID" || { bad "Anlegen: HTTP $CODE $RES"; exit 1; }

cleanup() {
  if [ "$KEEP" = 1 ]; then echo "(KEEP=1: Server $ID bleibt)"; return; fi
  step "9. Aufraeumen"
  api POST "/api/v1/servers/$ID/power" '{"action":"kill"}' >/dev/null
  sleep 2
  api DELETE "/api/v1/servers/$ID" >/dev/null
  [ "$CODE" -lt 300 ] && ok "Server geloescht" || bad "Loeschen: HTTP $CODE"
  if command -v docker >/dev/null; then
    if LEFT="$(docker ps -a --filter "label=nexuscore.server=$ID" --format '{{.Names}}' 2>&1)"; then
      [ -z "$LEFT" ] && ok "kein Container mehr" || bad "Container $ID ist noch da: $LEFT"
    else
      bad "docker ps nicht lesbar: $LEFT"
    fi
  fi
}
trap cleanup EXIT

step "5. Starten (Image wird beim ersten Mal geladen, bis zu ${WAIT_START}s)"
api POST "/api/v1/servers/$ID/power" '{"action":"start"}' >/dev/null
[ "$CODE" -lt 300 ] && ok "Startbefehl angenommen" || bad "Start: HTTP $CODE"
STATUS=""; for _ in $(seq 1 "$WAIT_START"); do
  api GET "/api/v1/servers/$ID"; STATUS="$(printf '%s' "$BODY" | jget server.status)"
  case "$STATUS" in running) break ;; error|offline) [ "$_" -gt 5 ] && break ;; esac
  sleep 1
done
[ "$STATUS" = running ] && ok "Status: running" || bad "Status nach dem Start: '$STATUS'"
if command -v docker >/dev/null; then
  L="$(docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.CapDrop}} {{.HostConfig.RestartPolicy.Name}}' "nxc-$ID" 2>&1)"
  [ "$L" = "2147483648 [ALL] no" ] && ok "Container: 2 GB, alle Rechte weg, kein Docker-Neustart" || bad "Container-Einstellungen: $L"
  docker inspect -f '{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}' "nxc-$ID" 2>/dev/null | grep -q -- '->/data' && ok "Server-Ordner ist eingehaengt" || bad "Server-Ordner nicht eingehaengt"
fi

step "6. Konsole"
sleep 5
api GET "/core/v1/servers/$ID/logs"; LOG="$BODY"
[ "$CODE" = 200 ] && [ -n "$LOG" ] && ok "Konsolenausgabe vorhanden ($(printf '%s' "$LOG" | wc -c) Zeichen)" || bad "keine Konsolenausgabe (HTTP $CODE)"
if [ "$STATUS" = running ]; then
  api POST "/api/v1/servers/$ID/command" '{"command":"say Smoke-Test"}' >/dev/null
  [ "$CODE" -lt 300 ] && ok "Befehl an die Konsole gesendet" || bad "Befehl: HTTP $CODE"
fi

step "7. Dateien (Ordner des Servers)"
api GET "/api/v1/servers/$ID/files" >/dev/null; [ "$CODE" = 200 ] && ok "Dateiliste" || bad "Dateiliste: HTTP $CODE"

step "8. Stoppen (mit dem Stop-Befehl des Spiels)"
if [ "$STATUS" = running ]; then
  api POST "/api/v1/servers/$ID/power" '{"action":"stop"}' >/dev/null
  END=""; for _ in $(seq 1 90); do api GET "/api/v1/servers/$ID"; END="$(printf '%s' "$BODY" | jget server.status)"; [ "$END" = offline ] && break; sleep 1; done
  [ "$END" = offline ] && ok "gestoppt (offline)" || bad "Status nach dem Stoppen: '$END'"
fi

echo
if [ "$FAILS" = 0 ]; then printf '\033[1;32mAlles in Ordnung.\033[0m\n'; else printf '\033[1;31m%s Schritt(e) fehlgeschlagen.\033[0m\n' "$FAILS"; fi
exit $((FAILS > 0))
