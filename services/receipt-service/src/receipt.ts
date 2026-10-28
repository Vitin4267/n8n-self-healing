import { randomUUID } from "node:crypto";
import { hashValue } from "../vendor/BoundaryAttest/src/hash.js";
import { signReceiptPayload } from "../vendor/BoundaryAttest/src/signing.js";
import type { Receipt, ReceiptPayload } from "../vendor/BoundaryAttest/src/receipts.js";
export { receiptHash } from "../vendor/BoundaryAttest/src/receipts.js";
export { verifyReceipt } from "../vendor/BoundaryAttest/src/signing.js";
import { AGENT_ID, lineageRefFor, receiptInput, toolFor, type StoredEvent } from "./evidence.js";
import type { SigningKey } from "./keys.js";

/**
 * Mirrors BoundaryAttest's `createSignedReceipt` field for field (see test/conformance.test.ts, which
 * checks this against the real function) but signs with a key that was loaded by the preflight.
 * `previous_receipt_hash` stays null: correlation is by lineage + explicit approval reference, and
 * the linear chain is not an authorization mechanism (see the plan / issue #1).
 */
export function buildReceipt(ev: StoredEvent, key: SigningKey, environment: string, now = new Date(), receiptId = randomUUID()): Receipt {
  const payload: ReceiptPayload = {
    receipt_id: receiptId,
    agent_id: AGENT_ID,
    tool: toolFor(ev.stage),
    action_status: ev.action_status,
    input_hash: hashValue(receiptInput(ev, environment)),
    output_hash: ev.output_evidence == null ? null : hashValue(ev.output_evidence),
    timestamp: now.toISOString(),
    previous_receipt_hash: null,
    public_key_id: key.keyId,
    receipt_role: "server_attested",
    receipt_policy: { mode: "required", reason: "default" },
  };
  if (ev.tool_metadata != null) payload.tool_metadata_hash = hashValue(ev.tool_metadata);
  payload.caller_type = ev.caller.type ?? "unknown";
  if (ev.caller.id !== undefined) payload.caller_id = ev.caller.id;
  if (ev.caller.authRef !== undefined) payload.caller_auth_ref = ev.caller.authRef;
  payload.lineage_ref = lineageRefFor(ev.incident_id);
  payload.lineage_type = "workflow_run";
  return { ...payload, signature: signReceiptPayload(payload, key.privateKeyPem) };
}
