import assert from "node:assert/strict";
import { test } from "node:test";
import { hashValue } from "../vendor/BoundaryAttest/src/hash.js";
import { createSignedReceipt } from "../vendor/BoundaryAttest/src/receipts.js";
import { verifyReceipt } from "../vendor/BoundaryAttest/src/signing.js";
import { receiptInput, toolFor, lineageRefFor, type StoredEvent } from "../src/evidence.js";
import { buildReceipt } from "../src/receipt.js";
import { ENV, newKey, sample, tmp } from "./helpers.js";

/**
 * Our receipt must be the same *shape* BoundaryAttest's own createSignedReceipt produces
 * (otherwise stock verifiers would reject it). We run the real function in a throwaway cwd
 * (its key paths are relative) and compare.
 */
test("buildReceipt matches BoundaryAttest's createSignedReceipt field for field", () => {
  const ev = { event_id: "11111111-1111-4111-8111-111111111111", ...sample("triage", 42) } as StoredEvent;
  const key = newKey();
  const ts = new Date("2026-10-27T12:00:00.000Z");
  const mine = buildReceipt(ev, key, ENV, ts);

  const cwd = process.cwd();
  process.chdir(tmp("stock-"));
  let stock;
  try {
    stock = createSignedReceipt({
      agentId: "n8n-self-healing", tool: toolFor(ev.stage), actionStatus: "executed",
      input: receiptInput(ev, ENV), output: ev.output_evidence, toolMetadata: ev.tool_metadata,
      caller: ev.caller, lineage: { ref: lineageRefFor(ev.incident_id), type: "workflow_run" },
      receiptRole: "server_attested", previousReceiptHash: null, timestamp: ts.toISOString(),
    });
  } finally { process.chdir(cwd); }

  assert.deepEqual(Object.keys(mine).sort(), Object.keys(stock).sort(), "same set of fields");
  for (const k of ["agent_id", "tool", "action_status", "input_hash", "output_hash", "timestamp", "previous_receipt_hash", "receipt_role",
                   "tool_metadata_hash", "caller_type", "caller_id", "caller_auth_ref", "lineage_ref", "lineage_type"] as const)
    assert.deepEqual((mine as any)[k], (stock as any)[k], `field ${k}`);
  assert.deepEqual(mine.receipt_policy, stock.receipt_policy);
  assert.equal(mine.input_hash, hashValue(receiptInput(ev, ENV)));
  // and the stock verifier accepts ours
  assert.equal(verifyReceipt(mine, key.publicKeyPem), true);
});
