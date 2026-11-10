#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo "  NEXUSCORE HOST DAEMON - lokaler Linux/macOS-Testbetrieb"
echo "========================================================"
echo ""

if [ ! -d node_modules ]; then
  echo "Installiere Abhaengigkeiten..."
  npm install
fi

echo "Baue NexusCore..."
npm run build

echo ""
echo "Starte Daemon (Beenden mit Strg+C)..."
echo ""
npm start
