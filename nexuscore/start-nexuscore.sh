#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "========================================================"
echo "  ⚡ Starte NexusCore im lokalen Linux/macOS Testmodus..."
echo "========================================================"
echo ""

if [ ! -d node_modules ]; then
    echo "Installiere erforderliche Abhängigkeiten..."
    npm install
fi

echo "Starte NexusCore Daemon..."
npm run dev
