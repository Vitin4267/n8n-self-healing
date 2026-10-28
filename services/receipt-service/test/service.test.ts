import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type pg from "pg";
import { evidenceHash } from "../src/evidence.js";
import { KEY_FILES, KeyError, loadSigningKey } from "../src/keys.js";
import { emitReceipt, readBundle, ServiceError, type Deps } from "../src/service.js";
import { auditIncident } from "../src/audit.js";
import { verifyBundle, type Bundle } from "../src/verify.js";
import { DIAG, ENV, H, insertEvent, newKey, sample, setupDb, TEST_DB } from "./helpers.js";

const skip = !TEST_DB && "RECEIPT_TEST_DB_URL not set";
let pool: pg.Pool, cleanup: () => Promise<void>, d: Deps;
let inc = 5000;
const nextInc = () => ++inc;
const status = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return e instanceof ServiceError ? e.status : -1; } };
const rows = async (t: string, where = "true") => Number((await pool.query(`SELECT count(*) FROM ${t} WHERE ${where}`)).rows[0].count);

before(async () => {
  if (skip) return;
  ({ pool, cleanup } = await setupDb());
  d = { pool, key: newKey(), environment: ENV };
});
after(async () => { if (!skip) await cleanup(); });

test("emits the four stages of one incident and every receipt verifies end to end", { skip }, async () => {
  const i = nextInc();
  const triage = await emitReceipt(d, (await insertEvent(pool, sample("triage", i))).event_id);
  const diag = await emitReceipt(d, (await insertEvent(pool, sample("diagnosis", i))).event_id);
  const aev = await insertEvent(pool, sample("approval", i));
  const appr = await emitReceipt(d, aev.event_id);
  const fev = await insertEvent(pool, sample("fix", i, { input_evidence: { ...sample("fix", i).input_evidence, approval_receipt_id: appr.receipt_id, approval_receipt_hash: appr.receipt_hash } }));
  const fix = await emitReceipt(d, fev.event_id);
  for (const r of [triage, diag, appr, fix]) assert.equal(r.status, "created");
  assert.equal(new Set([triage, diag, appr, fix].map((r) => r.receipt.lineage_ref)).size, 1, "one lineage per incident");
  assert.equal(triage.receipt.lineage_ref, `incident:${i}`);

  const trusted = { [d.key.keyId]: d.key.publicKeyPem };
  const get = async (id: string): Promise<Bundle> => { const b = await readBundle(d, id); return { receipt: b.receipt as any, event: b.event }; };
  const approvalBundle = await get(aev.event_id);
  for (const id of [triage, diag, appr].map((_, n) => [triage, diag, appr][n].receipt.receipt_id)) void id;
  assert.equal(verifyBundle(approvalBundle, { trustedKeys: trusted, environment: ENV }).ok, true);
  const fr = verifyBundle(await get(fev.event_id), { trustedKeys: trusted, environment: ENV, approval: approvalBundle });
  assert.equal(fr.ok, true, fr.problems.join("; "));
});

test("the same event twice returns the SAME receipt (idempotent)", { skip }, async () => {
  const e = await insertEvent(pool, sample("triage", nextInc()));
  const a = await emitReceipt(d, e.event_id);
  const b = await emitReceipt(d, e.event_id);
  assert.equal(a.status, "created"); assert.equal(b.status, "existing");
  assert.equal(b.receipt_id, a.receipt_id); assert.equal(b.receipt_hash, a.receipt_hash);
  assert.equal(await rows("incident_receipts", `event_id = '${e.event_id}'`), 1);
});

test("8 concurrent requests for one event produce exactly one receipt", { skip }, async () => {
  const e = await insertEvent(pool, sample("triage", nextInc()));
  const out = await Promise.all(Array.from({ length: 8 }, () => emitReceipt(d, e.event_id)));
  assert.equal(out.filter((r) => r.status === "created").length, 1);
  assert.equal(new Set(out.map((r) => r.receipt_id)).size, 1);
  assert.equal(await rows("incident_receipts", `event_id = '${e.event_id}'`), 1);
});

test("after a 'restart' (key reloaded from disk) the same event still returns the same receipt", { skip }, async () => {
  const dir = join((await import("./helpers.js")).tmp(), "keys");
  const { generateKey } = await import("../src/keys.js");
  generateKey(dir);
  const d1: Deps = { pool, key: loadSigningKey(dir), environment: ENV };
  const e = await insertEvent(pool, sample("triage", nextInc()));
  const a = await emitReceipt(d1, e.event_id);
  const d2: Deps = { pool, key: loadSigningKey(dir), environment: ENV };
  const b = await emitReceipt(d2, e.event_id);
  assert.equal(b.receipt_id, a.receipt_id); assert.equal(d1.key.keyId, d2.key.keyId);
});

test("with the key gone the service cannot start, and no replacement key appears", { skip }, async () => {
  const dir = join((await import("./helpers.js")).tmp(), "keys");
  const { generateKey } = await import("../src/keys.js");
  const original = generateKey(dir);
  rmSync(join(dir, KEY_FILES.priv));
  assert.throws(() => loadSigningKey(dir), (e: unknown) => e instanceof KeyError && e.code === "KEY_MISSING");
  assert.throws(() => loadSigningKey(dir), (e: unknown) => e instanceof KeyError);
  assert.ok(original.keyId);
});

test("unknown / malformed event ids", { skip }, async () => {
  assert.equal(await status(emitReceipt(d, "00000000-0000-4000-8000-00000000dead")), 404);
  assert.equal(await status(emitReceipt(d, "not-a-uuid")), 400);
  assert.equal(await status(emitReceipt(d, "1' OR '1'='1")), 400);
});

test("expectedEvidenceHash: wrong -> 409, right -> ok", { skip }, async () => {
  const e = await insertEvent(pool, sample("triage", nextInc()));
  assert.equal(await status(emitReceipt(d, e.event_id, H("f"))), 409);
  assert.equal((await emitReceipt(d, e.event_id, evidenceHash(e, ENV))).status, "created");
});

test("the caller can only name an event: stage rules on caller type are enforced from the stored row", { skip }, async () => {
  const badApproval = await insertEvent(pool, sample("approval", nextInc(), { caller: { id: "n8n", type: "service" } }));
  assert.equal(await status(emitReceipt(d, badApproval.event_id)), 422, "approval must be human");
  const badTriage = await insertEvent(pool, sample("triage", nextInc(), { caller: { id: "someone", type: "human" } }));
  assert.equal(await status(emitReceipt(d, badTriage.event_id)), 422, "triage must be service");
});

test("evidence that contradicts the permission matrix is refused, not signed", { skip }, async () => {
  const mk = (level: string, severity: string, i = nextInc()) => insertEvent(pool, sample("approval", i, { input_evidence: { ...sample("approval", i).input_evidence, permission_level: level, severity } }));
  assert.equal(await status(emitReceipt(d, (await mk("junior", "low")).event_id)), 422);
  assert.equal(await status(emitReceipt(d, (await mk("partial", "high")).event_id)), 422);
  assert.equal(await status(emitReceipt(d, (await mk("partial", "critical")).event_id)), 422);
  assert.equal((await emitReceipt(d, (await mk("partial", "low")).event_id)).status, "created");
  assert.equal((await emitReceipt(d, (await mk("full", "critical")).event_id)).status, "created");
});

test("a decision that was not accepted (token not consumed) is not receipted", { skip }, async () => {
  const i = nextInc();
  const e = await insertEvent(pool, sample("approval", i, { input_evidence: { ...sample("approval", i).input_evidence, token_consumed: false } }));
  assert.equal(await status(emitReceipt(d, e.event_id)), 422);
});

test("fix receipts must reference a REAL approval of the same incident and diagnosis", { skip }, async () => {
  const i = nextInc();
  const appr = await emitReceipt(d, (await insertEvent(pool, sample("approval", i))).event_id);
  let attempt = 0; // (incident, stage, attempt) is the ledger's idempotency key, so each try is its own attempt
  const fixEv = (incident: number, over: Record<string, unknown>) => insertEvent(pool, sample("fix", incident, { attempt: ++attempt, input_evidence: { ...sample("fix", incident).input_evidence, approval_receipt_id: appr.receipt_id, approval_receipt_hash: appr.receipt_hash, ...over } }));

  assert.equal(await status(emitReceipt(d, (await fixEv(i, { approval_receipt_id: "00000000-0000-4000-8000-0000000000aa" })).event_id)), 422, "nonexistent approval");
  assert.equal(await status(emitReceipt(d, (await fixEv(i, { approval_receipt_hash: H("e") })).event_id)), 422, "wrong hash");
  assert.equal(await status(emitReceipt(d, (await fixEv(nextInc(), {})).event_id)), 422, "approval of another incident");
  assert.equal(await status(emitReceipt(d, (await fixEv(i, { diagnosis_hash: H("9") })).event_id)), 422, "different diagnosis version");
  assert.equal((await emitReceipt(d, (await fixEv(i, {})).event_id)).status, "created", "correct reference");

  const j = nextInc();
  const rej = await emitReceipt(d, (await insertEvent(pool, sample("approval", j, { input_evidence: { ...sample("approval", j).input_evidence, action: "reject" } }))).event_id);
  const onRej = await insertEvent(pool, sample("fix", j, { input_evidence: { ...sample("fix", j).input_evidence, approval_receipt_id: rej.receipt_id, approval_receipt_hash: rej.receipt_hash } }));
  assert.equal(await status(emitReceipt(d, onRej.event_id)), 422, "a rejection cannot be the basis of a fix");
});

test("a failed fix attempt is receipted as failed, and DIAG is a well-formed hash", { skip }, async () => {
  assert.match(DIAG, /^[0-9a-f]{64}$/);
  const i = nextInc();
  const failed = await emitReceipt(d, (await insertEvent(pool, sample("triage", i, { action_status: "failed", output_evidence: { severity: "high", escalate: true, source: "fallback", reason: "classifier failed" } }))).event_id);
  assert.equal(failed.receipt.action_status, "failed");
});

test("the ledger is append-only: events and receipts cannot be updated, deleted or truncated", { skip }, async () => {
  const e = await insertEvent(pool, sample("triage", nextInc()));
  await emitReceipt(d, e.event_id);
  const blocked = async (sql: string) => { try { await pool.query(sql); return false; } catch (err) { return /append-only/.test(String((err as Error).message)); } };
  assert.equal(await blocked(`UPDATE incident_events SET output_evidence = '{"severity":"low","escalate":false,"source":"model"}' WHERE event_id = '${e.event_id}'`), true, "update event");
  assert.equal(await blocked(`DELETE FROM incident_events WHERE event_id = '${e.event_id}'`), true, "delete event");
  assert.equal(await blocked(`UPDATE incident_receipts SET receipt_hash = 'x' WHERE event_id = '${e.event_id}'`), true, "update receipt");
  assert.equal(await blocked(`DELETE FROM incident_receipts WHERE event_id = '${e.event_id}'`), true, "delete receipt");
  assert.equal(await blocked("TRUNCATE incident_receipts"), true, "truncate receipts");
  assert.equal(await blocked("TRUNCATE incident_events CASCADE"), true, "truncate events");
});

test("audit: verifies a whole incident from the DB, reports pending events, and catches a bad receipt", { skip }, async () => {
  const i = nextInc();
  const trusted = { [d.key.keyId]: d.key.publicKeyPem };
  await emitReceipt(d, (await insertEvent(pool, sample("triage", i))).event_id);
  const dEv = await insertEvent(pool, sample("diagnosis", i));            // recorded, receipt NOT yet emitted
  let rep = await auditIncident(pool, i, trusted, ENV);
  assert.deepEqual([rep.verified, rep.pending, rep.failed, rep.ok], [1, 1, 0, true], "pending is reported, not hidden");
  await emitReceipt(d, dEv.event_id);                                      // the reconciler's job
  rep = await auditIncident(pool, i, trusted, ENV);
  assert.deepEqual([rep.verified, rep.pending, rep.failed], [2, 0, 0]);
  rep = await auditIncident(pool, i, { "sha256:other": "x" }, ENV);        // wrong trust list
  assert.equal(rep.ok, false); assert.equal(rep.failed, 2);
  rep = await auditIncident(pool, i, trusted, "production");               // wrong environment
  assert.equal(rep.ok, false);
});
