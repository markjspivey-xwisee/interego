#!/usr/bin/env bash
# Start the holodeck.
#
#   bash examples/holodeck/bin/start.sh
#   open http://127.0.0.1:7200

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."

echo "═══════════════════════════════════════════════════════════════════"
echo "  Holodeck — Interego multi-agent control room"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  identities:  examples/holodeck/.holodeck/identities/"
echo "  loops:       examples/holodeck/.holodeck/loops/"
echo "  run history: examples/holodeck/.holodeck/runs/"
echo ""
echo "  dashboard:   http://127.0.0.1:7200"
echo ""
echo "  Stop: Ctrl+C"
echo ""

exec node server.mjs
