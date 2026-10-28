import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type pg from "pg";
import { createReceiptServer } from "../src/server.js";
import type { Deps } from "../src/service.js";
import { verifyBundle } from "../src/verify.js";
import { ENV, insertEvent, newKey, sample, setupDb, TEST_DB } from "./helpers.js";

const skip = !TEST_DB && "RECEIPT_TEST_DB_URL not set";
const TOKEN = "t".repeat(40);
let pool: pg.Pool, cleanup: () => Promise<void>, d: Deps, base = "", close: () => Promise<void>;

before(async () => {
  if (skip) return;
  ({ pool, cleanup } = await setupDb());
  d = { pool, key: newKey(), environment: ENV };
  const srv = createReceiptServer(d, TOKEN);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => new Promise((r) => srv.close(() => r()));
});
after(async () => { if (skip) return; await close(); await cleanup(); });

const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
  fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });

test("refuses to be created with a short token", { skip }, () => {
  assert.throws(() => createReceiptServer(d, "short"));
});

test("healthz is open and reports only the public key id", { skip }, async () => {
  const r = await call("/healthz", {}, null);
  assert.equal(r.status, 200);
  const j = await r.json() as Record<string, unknown>;
  assert.equal(j.key_id, d.key.keyId); assert.equal(JSON.stringify(j).includes("PRIVATE"), false);
});

test("everything else requires the bearer token", { skip }, async () => {
  assert.equal((await call("/v1/receipts", { method: "POST", body: "{}" }, null)).status, 401);
  assert.equal((await call("/v1/receipts", { method: "POST", body: "{}" }, "x".repeat(40))).status, 401);
  assert.equal((await call("/v1/receipts/00000000-0000-4000-8000-000000000000", {}, null)).status, 401);
});

test("POST creates (201) then returns the same receipt (200); GET exports a verifiable bundle", { skip }, async () => {
  const e = await insertEvent(pool, sample("triage", 8001));
  const a = await call("/v1/receipts", { method: "POST", body: JSON.stringify({ eventId: e.event_id }) });
  assert.equal(a.status, 201);
  const ja = await a.json() as any;
  const b = await call("/v1/receipts", { method: "POST", body: JSON.stringify({ eventId: e.event_id }) });
  assert.equal(b.status, 200);
  assert.equal((await b.json() as any).receipt_id, ja.receipt_id);

  const g = await call(`/v1/receipts/${e.event_id}`);
  assert.equal(g.status, 200);
  const bundle = await g.json() as any;
  const v = verifyBundle(bundle, { trustedKeys: { [d.key.keyId]: d.key.publicKeyPem }, environment: bundle.environment });
  assert.equal(v.ok, true, v.problems.join("; "));
});

test("the request cannot smuggle in stage/level/severity: only the event id matters", { skip }, async () => {
  const e = await insertEvent(pool, sample("triage", 8002));
  const r = await call("/v1/receipts", { method: "POST", body: JSON.stringify({ eventId: e.event_id, stage: "approval", permission_level: "full", severity: "low", caller: { type: "human" } }) });
  assert.equal(r.status, 201);
  const j = await r.json() as any;
  assert.equal(j.receipt.tool, "incident.triage");
  assert.equal(j.receipt.caller_type, "service");
});

test("bad input: invalid JSON, unknown event, oversized body", { skip }, async () => {
  assert.equal((await call("/v1/receipts", { method: "POST", body: "{not json" })).status, 400);
  assert.equal((await call("/v1/receipts", { method: "POST", body: JSON.stringify({ eventId: "00000000-0000-4000-8000-00000000beef" }) })).status, 404);
  assert.equal((await call("/v1/receipts", { method: "POST", body: JSON.stringify({ eventId: "x".repeat(40_000) }) })).status, 413);
  assert.equal((await call("/nope")).status, 404);
});
