import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../vendor/BoundaryAttest/src/hash.js";

export type SigningKey = { privateKeyPem: string; publicKeyPem: string; keyId: string };

export type KeyErrorCode = "KEY_MISSING" | "KEY_PERMS" | "KEY_MISMATCH" | "KEY_SELFTEST" | "KEY_EXISTS";
export class KeyError extends Error {
  constructor(public code: KeyErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

export const KEY_FILES = {
  priv: "signing-private.pem",
  pub: "signing-public.pem",
  id: "signing-key-id.txt",
} as const;

/** Same derivation as BoundaryAttest (`sha256:` + first 24 hex of sha256(publicKeyPem)). */
export function keyIdFor(publicKeyPem: string): string {
  return `sha256:${sha256(publicKeyPem).slice(0, 24)}`;
}

/**
 * Preflight. Loads the signing key or THROWS. It never creates anything: if a file is missing the
 * service must refuse to start instead of inventing a new signer identity (BoundaryAttest's own
 * `setupKeys()` would silently do that, which is why the service does not use it).
 */
export function loadSigningKey(dir: string): SigningKey {
  const p = Object.fromEntries(Object.entries(KEY_FILES).map(([k, f]) => [k, join(dir, f)])) as Record<
    keyof typeof KEY_FILES,
    string
  >;
  for (const f of Object.values(p)) {
    if (!existsSync(f)) throw new KeyError("KEY_MISSING", `${f} not found (refusing to generate a new key; run keygen explicitly)`);
  }
  for (const f of [dir, p.priv]) {
    const mode = statSync(f).mode & 0o777;
    if (mode & 0o077) throw new KeyError("KEY_PERMS", `${f} is accessible by group/others (mode ${mode.toString(8)}); expected 600/700`);
  }
  const privateKeyPem = readFileSync(p.priv, "utf8");
  const publicKeyPem = readFileSync(p.pub, "utf8");
  const storedId = readFileSync(p.id, "utf8").trim();

  const derivedPub = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }).toString();
  if (derivedPub.trim() !== publicKeyPem.trim()) throw new KeyError("KEY_MISMATCH", "public key file does not belong to the private key");
  const keyId = keyIdFor(publicKeyPem);
  if (storedId !== keyId) throw new KeyError("KEY_MISMATCH", `key id file (${storedId}) does not match the public key (${keyId})`);

  const probe = Buffer.from("receipt-service-preflight");
  if (!verify(null, probe, publicKeyPem, sign(null, probe, privateKeyPem))) throw new KeyError("KEY_SELFTEST", "sign/verify round trip failed");
  return { privateKeyPem, publicKeyPem, keyId };
}

/** Explicit, one-time key creation. Refuses to touch an existing key directory's files. */
export function generateKey(dir: string): SigningKey {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const f of Object.values(KEY_FILES)) {
    if (existsSync(join(dir, f))) throw new KeyError("KEY_EXISTS", `${join(dir, f)} already exists; refusing to overwrite a signing identity`);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const keyId = keyIdFor(publicKey);
  writeFileSync(join(dir, KEY_FILES.priv), privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(join(dir, KEY_FILES.pub), publicKey, { encoding: "utf8", flag: "wx" });
  writeFileSync(join(dir, KEY_FILES.id), `${keyId}\n`, { encoding: "utf8", flag: "wx" });
  return loadSigningKey(dir);
}
