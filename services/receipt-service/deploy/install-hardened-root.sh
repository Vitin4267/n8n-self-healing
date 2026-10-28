#!/usr/bin/env bash
# HARDENED install: the signing key lives under a dedicated system user that neither n8n nor Claude
# Code runs as. This is what actually separates "who can sign" from "who runs the pipeline".
#
#   sudo bash services/receipt-service/deploy/install-hardened-root.sh
#
# STATUS: written and syntax-checked, but NOT exercised (it needs root, which the automation that wrote
# it did not have). Read it, then run it once yourself and re-run `deploy/smoke.md` steps.
#
# What it does (idempotent):
#   - system user `boundaryattest` (no login, no home)
#   - code copied to /opt/n8n-self-healing-receipts (root-owned, read-only for the service)
#   - a private copy of the node binary there (the service must not depend on anyone's ~/.nvm)
#   - key + env + token under /var/lib and /etc, readable ONLY by boundaryattest
#   - hardened system unit, loopback only
# The unit must be able to read the DB role password from the env copied from the unprivileged
# provisioning (deploy/provision.sh), then you should delete that user-owned copy.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
SVC=boundaryattest
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OPT=/opt/n8n-self-healing-receipts
VAR=/var/lib/n8n-self-healing-attest
ETC=/etc/n8n-self-healing-attest
OWNER_HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"
OLD_ENV="$OWNER_HOME/.config/n8n-self-healing-attest/env"
NODE_BIN="$(sudo -u "${SUDO_USER:-root}" bash -lc 'command -v node')"

id "$SVC" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC"

install -d -m 755 -o root -g root "$OPT" "$OPT/bin"
BUILD_AS="${SUDO_USER:-root}"
# 1) build with the dev dependencies (tsc), as the unprivileged owner of the checkout
sudo -u "$BUILD_AS" bash -lc "cd '$SRC' && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null"
# 2) production-only node_modules, installed in a scratch dir so the dev checkout stays untouched
STAGE="$(mktemp -d)"
cp "$SRC/package.json" "$SRC/package-lock.json" "$STAGE/"
chown "$BUILD_AS" "$STAGE"
sudo -u "$BUILD_AS" bash -lc "cd '$STAGE' && npm ci --omit=dev --no-audit --no-fund >/dev/null"
rm -rf -- "${OPT:?}/dist" "${OPT:?}/node_modules"
cp -r "$SRC/dist" "$STAGE/node_modules" "$SRC/package.json" "$OPT/"
rm -rf -- "${STAGE:?}"
install -m 755 "$NODE_BIN" "$OPT/bin/node"
chown -R root:root "$OPT"

install -d -m 700 -o "$SVC" -g "$SVC" "$VAR" "$VAR/keys" "$ETC"
if [ ! -f "$ETC/env" ]; then
  [ -f "$OLD_ENV" ] || { echo "missing $OLD_ENV: run deploy/provision.sh first (creates the DB role)"; exit 1; }
  # same DB role/password, but the key directory and token now live in the service user's space
  grep -E '^(RECEIPT_DB_URL|RECEIPT_ENVIRONMENT|RECEIPT_HOST|RECEIPT_PORT)=' "$OLD_ENV" > "$ETC/env"
  echo "RECEIPT_KEY_DIR=$VAR/keys" >> "$ETC/env"
  echo "RECEIPT_TOKEN_FILE=$ETC/token" >> "$ETC/env"
  chown "$SVC:$SVC" "$ETC/env"; chmod 600 "$ETC/env"
fi
if [ ! -f "$ETC/token" ]; then
  head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-48 > "$ETC/token"
  chown "$SVC:$SVC" "$ETC/token"; chmod 600 "$ETC/token"
  echo ">>> New service token (put it in n8n as a Header Auth credential 'Authorization: Bearer <token>'):"
  cat "$ETC/token"; echo
fi

if [ -e "$VAR/keys/signing-private.pem" ]; then
  sudo -u "$SVC" "$OPT/bin/node" "$OPT/dist/src/cli.js" preflight --dir "$VAR/keys"
else
  sudo -u "$SVC" "$OPT/bin/node" "$OPT/dist/src/cli.js" keygen --dir "$VAR/keys"
  echo ">>> NEW signing identity. Add its public key to services/receipt-service/trusted-keys.json (keep old keys: they still verify old receipts):"
  cat "$VAR/keys/signing-key-id.txt"; cat "$VAR/keys/signing-public.pem"
fi

install -m 644 "$SRC/deploy/n8n-self-healing-receipts.service" /etc/systemd/system/n8n-self-healing-receipts.service
systemctl daemon-reload
systemctl enable --now n8n-self-healing-receipts.service
echo "Done. Now delete the unprivileged copies: rm -r $OWNER_HOME/.config/n8n-self-healing-attest $OWNER_HOME/.local/share/n8n-self-healing-attest"
echo "(then point n8n at http://127.0.0.1:8787 with the token above; the old user-owned key stays valid for the receipts it already signed.)"
