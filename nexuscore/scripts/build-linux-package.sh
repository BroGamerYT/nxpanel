#!/usr/bin/env bash
# Baut das Linux-Paket des Cores: NexusCore-linux.tar.gz (Core, Weboberflaeche, Spielvorlagen, Einrichtungsskript).
#
#   bash nexuscore/scripts/build-linux-package.sh          # vom Hauptordner des Repositorys aus: bauen und packen
#   SKIP_BUILD=1 bash nexuscore/scripts/build-linux-package.sh   # nur packen (dist und web/dist sind schon gebaut)
#
# Der Aufbau im Archiv entspricht dem Repository, weil deploy/linux/install-core.sh die Ordner relativ zu sich sucht
# (nexuscore/, eggs/, web/dist/, docs/EGG-KATALOG.md). node_modules gehoert nicht ins Paket: das Skript installiert
# die Abhaengigkeiten auf dem Zielrechner (npm ci --omit=dev), dort passen auch die nativen Module.
# Jeder Schritt wird geprueft - ein Archiv ohne Core-Code darf nie veroeffentlicht werden.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$CORE/.." && pwd)"
OUT_DIR="${OUT_DIR:-$CORE/dist-package}"
NAME=NexusCore-linux.tar.gz

fail() { echo "::error::$*" >&2; echo "FEHLER: $*" >&2; exit 1; }
need() { [ -e "$1" ] || fail "fehlt: ${1#"$ROOT"/}"; }

VERSION="$(cd "$CORE" && node -p "require('./package.json').version")"
echo "==> NexusCore $VERSION fuer Linux packen"

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "==> Weboberflaeche bauen"
  (cd "$ROOT/web" && npm ci && npm run build) || fail "Weboberflaeche konnte nicht gebaut werden"
  echo "==> Core bauen"
  (cd "$CORE" && npm ci && npm run build) || fail "Core konnte nicht gebaut werden"
fi

# --- Pruefen, was gebaut wurde ---------------------------------------------------------------------------
need "$CORE/dist/index.js"
need "$ROOT/web/dist/index.html"
need "$ROOT/docs/EGG-KATALOG.md"
need "$CORE/deploy/linux/install-core.sh"
need "$CORE/deploy/linux/nexuscore.service"
need "$CORE/deploy/linux/uninstall-core.sh"
need "$CORE/scripts/smoke-test.sh"
ls "$ROOT"/eggs/*.json >/dev/null 2>&1 || fail "keine Spielvorlagen in eggs/"
[ "$(wc -c < "$CORE/dist/index.js")" -gt 1000 ] || fail "dist/index.js ist leer oder zu klein"
if grep -q $'\r' "$CORE/deploy/linux/install-core.sh"; then fail "install-core.sh hat Windows-Zeilenenden (CRLF) - .gitattributes verlangt LF"; fi

# --- Zusammenstellen -------------------------------------------------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
P="$STAGE/nexuscore-linux"
mkdir -p "$P/nexuscore/scripts" "$P/web" "$P/docs"
cp -a "$CORE/dist" "$P/nexuscore/dist"
cp -a "$CORE/package.json" "$CORE/package-lock.json" "$P/nexuscore/"
cp -a "$CORE/docs" "$P/nexuscore/docs"
cp -a "$CORE/deploy" "$P/nexuscore/deploy"
cp -a "$CORE/scripts/smoke-test.sh" "$P/nexuscore/scripts/"
[ -f "$CORE/.env.example" ] && cp -a "$CORE/.env.example" "$P/nexuscore/"
[ -f "$CORE/README.md" ] && cp -a "$CORE/README.md" "$P/nexuscore/"
cp -a "$ROOT/eggs" "$P/eggs"
cp -a "$ROOT/web/dist" "$P/web/dist"
cp -a "$ROOT/docs/EGG-KATALOG.md" "$P/docs/"
# Windows- und macOS-Dateien braucht das Linux-Paket nicht (auch keine Reste eines Windows-Baus in dist/)
rm -rf "$P/nexuscore/deploy/windows" "$P/nexuscore/deploy/macos"
rm -f "$P/nexuscore/dist/"*.exe "$P/nexuscore/dist/"*.msi "$P/nexuscore/dist/"*.wixpdb "$P/nexuscore/dist/bundle.cjs" "$P/nexuscore/dist/sea-prep.blob" "$P/nexuscore/dist/sea-config.json"

cat > "$P/INSTALL.txt" <<EOF
NexusCore $VERSION fuer Linux (Debian 12 / Ubuntu 22.04 oder neuer, Docker und Node.js 22.13+ vorausgesetzt)

  tar xzf $NAME
  cd nexuscore-linux
  sudo bash nexuscore/deploy/linux/install-core.sh

Probelauf ohne Aenderungen:  bash nexuscore/deploy/linux/install-core.sh --dry-run
Danach: Erstes Passwort der Weboberflaeche in /var/lib/nexuscore/ERSTES-PASSWORT.txt
Mehr: nexuscore/docs/INSTALLATION.md
EOF
echo "$VERSION" > "$P/VERSION"

# --- Packen und das Archiv selbst pruefen ----------------------------------------------------------------
mkdir -p "$OUT_DIR"
tar --owner=0 --group=0 -czf "$OUT_DIR/$NAME" -C "$STAGE" nexuscore-linux
LIST="$(tar -tzf "$OUT_DIR/$NAME")"
for must in nexuscore-linux/nexuscore/dist/index.js nexuscore-linux/web/dist/index.html nexuscore-linux/nexuscore/deploy/linux/install-core.sh \
            nexuscore-linux/nexuscore/package-lock.json nexuscore-linux/docs/EGG-KATALOG.md nexuscore-linux/INSTALL.txt; do
  grep -qx "$must" <<<"$LIST" || fail "im Archiv fehlt: $must"
done
[ "$(grep -c '^nexuscore-linux/eggs/.*\.json$' <<<"$LIST")" -gt 10 ] || fail "im Archiv fehlen die Spielvorlagen"
if grep -q 'node_modules' <<<"$LIST"; then fail "node_modules gehoert nicht ins Archiv"; fi
if grep -E -q '\.(exe|msi)$' <<<"$LIST"; then fail "Windows-Programme gehoeren nicht ins Linux-Archiv"; fi

SIZE="$(du -h "$OUT_DIR/$NAME" | cut -f1)"
echo "==> Fertig: $OUT_DIR/$NAME ($SIZE)"
