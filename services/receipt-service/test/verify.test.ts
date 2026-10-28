import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredEvent } from "../src/evidence.js";
import { buildReceipt, receiptHash } from "../src/receipt.js";
import { verifyBundle, type Bundle } from "../src/verify.js";
import { DIAG, ENV, H, newKey, sample } from "./helpers.js";

const key = newKey();
const trusted = { [key.keyId]: key.publicKeyPem };
let seq = 0;
const ev = (stage: StoredEvent["stage"], incident: number, over = {}): StoredEvent =>
  ({ event_id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ...sample(stage, incident, over) }) as StoredEvent;
const bundle = (e: StoredEvent): Bundle => ({ receipt: buildReceipt(e, key, ENV), event: e });
const verify = (b: Bundle, approval?: Bundle, keys = trusted) => verifyBundle(b, { trustedKeys: keys, environment: ENV, approval });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const has = (r: { problems: string[] }, re: RegExp) => r.problems.some((p) => re.test(p));

test("a good approval receipt verifies on all four counts", () => {
  const r = verify(bundle(ev("approval", 7)));
  assert.deepEqual([r.ok, r.crypto_valid, r.key_trusted, r.evidence_consistent, r.references_consistent], [true, true, true, true, true], r.problems.join("; "));
});

// ---- tampering with the EVIDENCE the receipt vouches for (receipt untouched) ----
test("changing the permission level in the evidence invalidates the receipt", () => {
  const b = bundle(ev("approval", 7, { input_evidence: { ...sample("approval", 7).input_evidence, permission_level: "partial", severity: "low" } }));
  assert.equal(verify(b).ok, true, "baseline: partial may decide low");
  const t = clone(b); t.event.input_evidence.permission_level = "full";
  const r = verify(t);
  assert.equal(r.ok, false); assert.equal(r.evidence_consistent, false); assert.equal(r.crypto_valid, true, "signature itself is intact: the evidence is what lies");
  assert.ok(has(r, /input_hash/));
});

test("changing the severity in the evidence invalidates the receipt", () => {
  const b = bundle(ev("approval", 7, { input_evidence: { ...sample("approval", 7).input_evidence, permission_level: "partial", severity: "low" } }));
  const t = clone(b); t.event.input_evidence.severity = "critical";
  const r = verify(t);
  assert.equal(r.ok, false); assert.ok(has(r, /input_hash/));
  assert.ok(has(r, /contradicts policy/), "partial deciding critical is also a policy contradiction");
});

test("changing the output invalidates the receipt", () => {
  const b = bundle(ev("fix", 7));
  const t = clone(b); t.event.output_evidence!.status = "aborted";
  const r = verify(t); assert.equal(r.ok, false); assert.ok(has(r, /output_hash/));
});

test("changing the caller identity invalidates the receipt", () => {
  const b = bundle(ev("approval", 7));
  const t = clone(b); t.event.caller.id = "approver:2";
  const r = verify(t); assert.equal(r.ok, false); assert.ok(has(r, /caller_id/));
});

test("changing the lineage (incident) invalidates the receipt", () => {
  const b = bundle(ev("approval", 7));
  const t = clone(b); t.event.incident_id = 8;
  const r = verify(t); assert.equal(r.ok, false); assert.ok(has(r, /lineage_ref/));
});

// ---- tampering with the RECEIPT itself ----
test("editing any signed receipt field breaks the signature", () => {
  for (const [field, value] of [["action_status", "failed"], ["caller_id", "approver:9"], ["lineage_ref", "incident:99"], ["input_hash", H("0")], ["tool", "incident.fix"]] as const) {
    const t = clone(bundle(ev("approval", 7))); (t.receipt as any)[field] = value;
    const r = verify(t);
    assert.equal(r.ok, false, field); assert.equal(r.crypto_valid, false, `${field}: signature must break`);
  }
});

test("a receipt signed by an attacker's key but claiming our key id fails", () => {
  const evil = newKey();
  const e = ev("approval", 7);
  const forged = buildReceipt(e, { ...evil, keyId: key.keyId }, ENV);
  const r = verify({ receipt: forged, event: e });
  assert.equal(r.ok, false); assert.equal(r.crypto_valid, false);
});

test("a validly signed receipt from an UNKNOWN key is not trusted", () => {
  const other = newKey();
  const e = ev("approval", 7);
  const r = verify({ receipt: buildReceipt(e, other, ENV), event: e });
  assert.equal(r.crypto_valid, false, "no trusted key to check it with");
  assert.equal(r.key_trusted, false); assert.equal(r.ok, false);
  const r2 = verifyBundle({ receipt: buildReceipt(e, other, ENV), event: e }, { trustedKeys: { [other.keyId]: other.publicKeyPem }, environment: ENV });
  assert.equal(r2.ok, true, "trust is a property of the key list you supply, not of the receipt");
});

test("a trusted-key file that does not hash to its id is not trusted", () => {
  const other = newKey();
  const e = ev("approval", 7);
  const r = verify({ receipt: buildReceipt(e, key, ENV), event: e }, undefined, { [key.keyId]: other.publicKeyPem });
  assert.equal(r.key_trusted, false); assert.equal(r.ok, false);
});

test("the environment is part of what is signed", () => {
  const b = bundle(ev("approval", 7));
  const r = verifyBundle(b, { trustedKeys: trusted, environment: "production" });
  assert.equal(r.ok, false); assert.ok(has(r, /input_hash/));
});

// ---- the fix receipt must carry the approval it relied on ----
function fixWith(approval: Bundle, over: Record<string, unknown> = {}, incident = 7): Bundle {
  return bundle(ev("fix", incident, { input_evidence: { ...sample("fix", incident).input_evidence, approval_receipt_id: approval.receipt.receipt_id, approval_receipt_hash: receiptHash(approval.receipt), diagnosis_hash: DIAG, ...over } }));
}

test("a fix receipt verifies when it references a real, matching approval", () => {
  const a = bundle(ev("approval", 7));
  const r = verify(fixWith(a), a);
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("a fix receipt cannot be verified without its approval bundle", () => {
  const a = bundle(ev("approval", 7));
  const r = verify(fixWith(a)); assert.equal(r.ok, false); assert.equal(r.references_consistent, false);
});

test("a fix pointing at the wrong approval hash fails", () => {
  const a = bundle(ev("approval", 7));
  const r = verify(fixWith(a, { approval_receipt_hash: H("e") }), a);
  assert.equal(r.ok, false); assert.ok(has(r, /approval_receipt_hash/));
});

test("a fix reusing another incident's approval fails", () => {
  const other = bundle(ev("approval", 99));
  const r = verify(fixWith(other), other);
  assert.equal(r.ok, false); assert.ok(has(r, /different incident/));
});

test("a fix whose approval was for a different diagnosis version fails", () => {
  const a = bundle(ev("approval", 7, { input_evidence: { ...sample("approval", 7).input_evidence, diagnosis_hash: H("9") } }));
  const r = verify(fixWith(a), a);
  assert.equal(r.ok, false); assert.ok(has(r, /different diagnosis/));
});

test("a fix pointing at a REJECTION fails", () => {
  const rej = bundle(ev("approval", 7, { input_evidence: { ...sample("approval", 7).input_evidence, action: "reject" } }));
  const r = verify(fixWith(rej), rej);
  assert.equal(r.ok, false); assert.ok(has(r, /not an approval decision/));
});

test("tampering with the approval the fix relies on is caught through the fix", () => {
  const a = bundle(ev("approval", 7));
  const f = fixWith(a);
  const t = clone(a); t.event.input_evidence.permission_level = "junior";
  const r = verify(f, t);
  assert.equal(r.ok, false); assert.equal(r.references_consistent, false);
});

test("evidence that contradicts the permission matrix is flagged even if someone signs it", () => {
  const bad = ev("approval", 7, { input_evidence: { ...sample("approval", 7).input_evidence, permission_level: "junior" } });
  const r = verify(bundle(bad));
  assert.equal(r.ok, false); assert.ok(has(r, /contradicts policy/));
});
