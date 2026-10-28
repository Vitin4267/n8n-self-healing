#!/usr/bin/env bash
# One-time, idempotent, NON-root provisioning of the receipt service. Installs nothing persistent
# (no systemd, no linger). Safe to re-run: it never overwrites a key, a token or a DB password.
#
#   bash services/receipt-service/deploy/provision.sh
#
# Creates:
#   $CONF/env            service environment (0600): DB URL for the least-privilege role, key dir, port
#   $CONF/token          bearer token n8n must send (0600)
#   $KEYS/*              Ed25519 signing key (dir 0700, private key 0600) -- generated ONCE, explicitly
#   DB: tables (append-only) + role receipts_svc (SELECT events; SELECT/INSERT receipts; nothing else)
#
# NOTE on custody: this runs as the same Unix user as n8n and Claude Code, so that user can read the
# key. For real isolation use deploy/install-hardened-root.sh (separate OS user, needs sudo).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CONF="${RECEIPT_CONF_DIR:-$HOME/.config/n8n-self-healing-attest}"
KEYS="${RECEIPT_KEY_DIR:-$HOME/.local/share/n8n-self-healing-attest/keys}"
DB_CONTAINER="${RECEIPT_DB_CONTAINER:-n8n-self-healing-db}"
DB_NAME="${RECEIPT_DB_NAME:-incidents}"
DB_ADMIN="${RECEIPT_DB_ADMIN:-healing}"
ADMIN_PW="$(cat "$REPO/.state/.pg-password")"
psql_admin() { docker exec -i -e PGPASSWORD="$ADMIN_PW" "$DB_CONTAINER" psql -U "$DB_ADMIN" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q "$@"; }

umask 077
mkdir -p "$CONF"; chmod 700 "$CONF"

echo "[1/5] build"
( cd "$HERE" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null )

echo "[2/5] migration (idempotent)"
psql_admin < "$HERE/migrations/001_receipts.sql"

echo "[3/5] least-privilege role receipts_svc"
if [ ! -f "$CONF/env" ]; then
  SVC_PW="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-40)"
  psql_admin -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='receipts_svc') THEN CREATE ROLE receipts_svc LOGIN; END IF; END \$\$;"
  psql_admin -c "ALTER ROLE receipts_svc WITH LOGIN PASSWORD '$SVC_PW' NOSUPERUSER NOCREATEDB NOCREATEROLE;"
  {
    echo "RECEIPT_DB_URL=postgres://receipts_svc:$SVC_PW@127.0.0.1:5433/$DB_NAME"
    echo "RECEIPT_KEY_DIR=$KEYS"
    echo "RECEIPT_TOKEN_FILE=$CONF/token"
    echo "RECEIPT_ENVIRONMENT=production"
    echo "RECEIPT_HOST=127.0.0.1"
    echo "RECEIPT_PORT=8787"
  } > "$CONF/env"
  chmod 600 "$CONF/env"
else
  echo "    env already exists; keeping the existing role password"
fi
psql_admin <<'SQL'
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM receipts_svc;
GRANT USAGE ON SCHEMA public TO receipts_svc;
GRANT SELECT ON incident_events TO receipts_svc;
GRANT SELECT, INSERT ON incident_receipts TO receipts_svc;
SQL

echo "[4/5] signing key (generated only if absent)"
if [ -e "$KEYS/signing-private.pem" ]; then
  ( cd "$HERE" && node dist/src/cli.js preflight --dir "$KEYS" )
else
  ( cd "$HERE" && node dist/src/cli.js keygen --dir "$KEYS" )
fi

echo "[5/5] service token + trusted public key"
[ -f "$CONF/token" ] || { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-48 > "$CONF/token"; chmod 600 "$CONF/token"; }
python3 - "$KEYS" "$HERE/trusted-keys.json" <<'PY'
import json, sys, pathlib
keys, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
kid = (keys / "signing-key-id.txt").read_text().strip()
pub = (keys / "signing-public.pem").read_text()
cur = json.loads(out.read_text()) if out.exists() else {}
cur[kid] = pub
out.write_text(json.dumps(cur, indent=2) + "\n")
print("    trusted-keys.json has", len(cur), "key(s); current:", kid)
PY
echo "done. run in foreground with: bash $HERE/deploy/run.sh"
