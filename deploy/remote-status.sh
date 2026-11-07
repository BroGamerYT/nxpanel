#!/usr/bin/env bash
# Gibt eine Momentaufnahme des Servers aus. Wird von der Live-Anzeige
# des Updaters im Takt aufgerufen.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/nxpanel}"
PORT="${PANEL_PORT:-8080}"
[ -f "$APP_DIR/.env" ] && PORT=$(grep -E '^PANEL_PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d '\r' || echo 8080)
PORT=${PORT:-8080}

C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_GREEN=$'\033[1;32m'
C_RED=$'\033[1;31m'; C_YELLOW=$'\033[1;33m'; C_CYAN=$'\033[1;36m'

bar() { # bar <prozent> <breite>
  local pct=${1%.*} width=$2 filled
  [ "$pct" -gt 100 ] 2>/dev/null && pct=100
  [ "$pct" -lt 0 ] 2>/dev/null && pct=0
  filled=$(( pct * width / 100 ))
  local color=$C_GREEN
  [ "$pct" -ge 75 ] && color=$C_YELLOW
  [ "$pct" -ge 90 ] && color=$C_RED
  # Vorsicht: printf mit Format, aber ohne Argumente gibt das Format trotzdem
  # einmal aus - deshalb die Null-Faelle ausdruecklich abfangen.
  printf '%s' "$color"
  [ "$filled" -gt 0 ] && printf '%0.s#' $(seq 1 "$filled")
  printf '%s' "$C_DIM"
  local rest=$(( width - filled ))
  [ "$rest" -gt 0 ] && printf '%0.s.' $(seq 1 "$rest")
  printf '%s' "$C_RESET"
}

echo "${C_CYAN}NexusPanel${C_RESET}  $(hostname)  ${C_DIM}$(date '+%d.%m.%Y %H:%M:%S')${C_RESET}"
echo

# --- Panel ---------------------------------------------------------------
READY=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/readyz" 2>/dev/null)
if [ -n "$READY" ]; then
  DB=$(echo "$READY" | grep -o '"database":[a-z]*' | cut -d: -f2)
  DOCK=$(echo "$READY" | grep -o '"docker":[a-z]*' | cut -d: -f2)
  mark() { [ "$1" = "true" ] && printf '%sok%s' "$C_GREEN" "$C_RESET" || printf '%sfehlt%s' "$C_RED" "$C_RESET"; }
  printf 'Panel      %sbereit%s   Datenbank %s   Docker %s\n' "$C_GREEN" "$C_RESET" "$(mark "$DB")" "$(mark "$DOCK")"
else
  printf 'Panel      %santwortet nicht%s auf Port %s\n' "$C_RED" "$C_RESET" "$PORT"
fi

if [ -L "$APP_DIR/current" ]; then
  echo "Fassung    $(basename "$(readlink -f "$APP_DIR/current")")"
fi
echo

# --- Host ----------------------------------------------------------------
read -r L1 L5 L15 _ < /proc/loadavg
CORES=$(nproc)
LOADPCT=$(awk -v l="$L1" -v c="$CORES" 'BEGIN{printf "%d", (l/c)*100}')
MEM_TOTAL=$(awk '/MemTotal/{print $2}' /proc/meminfo)
MEM_AVAIL=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
MEM_PCT=$(( (MEM_TOTAL - MEM_AVAIL) * 100 / MEM_TOTAL ))
MEM_USED_GB=$(awk -v t="$MEM_TOTAL" -v a="$MEM_AVAIL" 'BEGIN{printf "%.1f", (t-a)/1048576}')
MEM_TOTAL_GB=$(awk -v t="$MEM_TOTAL" 'BEGIN{printf "%.0f", t/1048576}')
DISK_PCT=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
DISK_FREE=$(df -Ph / | awk 'NR==2{print $4}')

printf '%-7s%s  %3d%%  %sLast %s auf %s Kernen%s\n' "CPU" "$(bar "$LOADPCT" 20)" "$LOADPCT" "$C_DIM" "$L1" "$CORES" "$C_RESET"
printf '%-7s%s  %3d%%  %s%s von %s GB%s\n' "RAM" "$(bar "$MEM_PCT" 20)" "$MEM_PCT" "$C_DIM" "$MEM_USED_GB" "$MEM_TOTAL_GB" "$C_RESET"
printf '%-7s%s  %3d%%  %s%s frei%s\n' "Platte" "$(bar "$DISK_PCT" 20)" "$DISK_PCT" "$C_DIM" "$DISK_FREE" "$C_RESET"
echo

# --- Container -----------------------------------------------------------
STATS=$(timeout 8 docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}' 2>/dev/null)
if [ -z "$STATS" ]; then
  echo "${C_DIM}Keine laufenden Container${C_RESET}"
else
  printf '%-22s %8s  %-22s %s\n' "CONTAINER" "CPU" "SPEICHER" "NETZ"
  echo "$STATS" | sort | while IFS=$'\t' read -r name cpu mem net; do
    printf '%-22s %8s  %-22s %s\n' "${name:0:22}" "$cpu" "$mem" "$net"
  done
fi
echo

# --- Letzte Ereignisse ---------------------------------------------------
if [ -f "$APP_DIR/.env" ]; then
  DBURL=$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '\r')
  if [ -n "$DBURL" ] && command -v docker >/dev/null; then
    EVENTS=$(docker exec nxp-postgres psql -U panel -d panel -t -A -F'  ' -c \
      "SELECT to_char(ts,'HH24:MI:SS'), rpad(kind,16), left(summary,52)
       FROM events ORDER BY id DESC LIMIT 6" 2>/dev/null)
    if [ -n "$EVENTS" ]; then
      echo "${C_CYAN}Letzte Ereignisse${C_RESET}"
      echo "$EVENTS" | tac | sed 's/^/  /'
    fi
  fi
fi
