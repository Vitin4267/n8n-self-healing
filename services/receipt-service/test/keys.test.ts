import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { generateKey, KEY_FILES, KeyError, keyIdFor, loadSigningKey } from "../src/keys.js";
import { tmp } from "./helpers.js";

const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as KeyError).code; } return "NO_ERROR"; };

test("keygen creates a 0600 private key in a 0700 dir and the preflight accepts it", () => {
  const dir = join(tmp(), "keys");
  const k = generateKey(dir);
  assert.equal(statSync(join(dir, KEY_FILES.priv)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(k.keyId, keyIdFor(k.publicKeyPem));
  assert.equal(loadSigningKey(dir).keyId, k.keyId);
});

test("restart preserves the signing identity", () => {
  const dir = join(tmp(), "keys");
  const first = generateKey(dir);
  assert.equal(loadSigningKey(dir).keyId, first.keyId);
  assert.equal(loadSigningKey(dir).keyId, first.keyId);
});

test("keygen refuses to overwrite an existing identity", () => {
  const dir = join(tmp(), "keys");
  generateKey(dir);
  assert.equal(code(() => generateKey(dir)), "KEY_EXISTS");
});

test("a missing key makes the preflight fail and creates NOTHING (no silent new identity)", () => {
  const dir = join(tmp(), "keys");
  const k = generateKey(dir);
  rmSync(join(dir, KEY_FILES.priv));
  const before = readdirSync(dir).sort();
  assert.equal(code(() => loadSigningKey(dir)), "KEY_MISSING");
  assert.deepEqual(readdirSync(dir).sort(), before, "preflight must not create files");
  assert.equal(existsSync(join(dir, KEY_FILES.priv)), false);
  assert.ok(k.keyId);
});

test("an empty directory also fails closed", () => {
  assert.equal(code(() => loadSigningKey(tmp())), "KEY_MISSING");
});

test("a group/world readable private key is rejected", () => {
  const dir = join(tmp(), "keys");
  generateKey(dir);
  chmodSync(join(dir, KEY_FILES.priv), 0o644);
  assert.equal(code(() => loadSigningKey(dir)), "KEY_PERMS");
});

test("a public key that does not belong to the private key is rejected", () => {
  const a = join(tmp(), "a"), b = join(tmp(), "b");
  generateKey(a); const kb = generateKey(b);
  writeFileSync(join(a, KEY_FILES.pub), kb.publicKeyPem);
  writeFileSync(join(a, KEY_FILES.id), `${kb.keyId}\n`);
  assert.equal(code(() => loadSigningKey(a)), "KEY_MISMATCH");
});

test("a tampered key id file is rejected", () => {
  const dir = join(tmp(), "keys");
  generateKey(dir);
  writeFileSync(join(dir, KEY_FILES.id), "sha256:deadbeefdeadbeefdeadbeef\n");
  assert.equal(code(() => loadSigningKey(dir)), "KEY_MISMATCH");
});
