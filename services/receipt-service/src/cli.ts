import { readFileSync } from "node:fs";
import { generateKey, loadSigningKey, KeyError } from "./keys.js";
import { createReceiptServer } from "./server.js";
import { makePool } from "./store.js";
import { verifyBundle, type Bundle } from "./verify.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const need = (n: string, env?: string) => { const v = flag(n) ?? (env ? process.env[env] : undefined); if (!v) { console.error(`missing --${n}${env ? ` or ${env}` : ""}`); process.exit(2); } return v; };

async function main() {
  switch (cmd) {
    case "keygen": {
      const k = generateKey(need("dir", "RECEIPT_KEY_DIR"));
      console.log(`created signing key ${k.keyId}`);
      return;
    }
    case "preflight": {
      const k = loadSigningKey(need("dir", "RECEIPT_KEY_DIR"));
      console.log(`ok ${k.keyId}`);
      return;
    }
    case "serve": {
      const key = loadSigningKey(need("dir", "RECEIPT_KEY_DIR")); // throws => service does NOT start
      const token = readFileSync(need("token-file", "RECEIPT_TOKEN_FILE"), "utf8").trim();
      const pool = makePool(need("db", "RECEIPT_DB_URL"), process.env.RECEIPT_DB_SCHEMA);
      const environment = process.env.RECEIPT_ENVIRONMENT ?? "production";
      const port = Number(process.env.RECEIPT_PORT ?? 8787);
      const host = process.env.RECEIPT_HOST ?? "127.0.0.1";
      createReceiptServer({ pool, key, environment }, token).listen(port, host, () => console.log(`receipt-service ${key.keyId} on ${host}:${port} (${environment})`));
      return;
    }
    case "verify": {
      // verify <bundle.json> --trusted <keys.json> [--approval <approval-bundle.json>] [--env production]
      const file = rest[0];
      if (!file) { console.error("usage: verify <bundle.json> --trusted <keys.json> [--approval <bundle.json>] [--env production]"); process.exit(2); }
      const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
      const b = load(file) as Bundle & { environment?: string };
      const approvalFile = flag("approval");
      const res = verifyBundle(b, {
        trustedKeys: load(need("trusted")),
        environment: flag("env") ?? b.environment ?? "production",
        approval: approvalFile ? (load(approvalFile) as Bundle) : undefined,
      });
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.ok ? 0 : 1);
    }
    default:
      console.error("usage: cli.js <keygen|preflight|serve|verify> ...");
      process.exit(2);
  }
}
main().catch((e) => { console.error(e instanceof KeyError ? e.message : e); process.exit(1); });
