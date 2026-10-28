#!/usr/bin/env bash
# Runs the service in the FOREGROUND with the provisioned environment (no daemon, no systemd).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONF="${RECEIPT_CONF_DIR:-$HOME/.config/n8n-self-healing-attest}"
set -a; . "$CONF/env"; set +a
cd "$HERE" && exec node dist/src/cli.js serve
