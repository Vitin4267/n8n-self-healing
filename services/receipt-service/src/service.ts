import type pg from "pg";
import type { Receipt } from "../vendor/BoundaryAttest/src/receipts.js";
import { evidenceHash, validateEvent, type StoredEvent } from "./evidence.js";
import type { SigningKey } from "./keys.js";
import { buildReceipt, receiptHash } from "./receipt.js";
import { getEvent, getReceiptByEvent, getReceiptById, insertReceipt, lockEvent } from "./store.js";

export class ServiceError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export type Deps = { pool: pg.Pool; key: SigningKey; environment: string };
export type EmitResult = {
  status: "created" | "existing";
  receipt_id: string;
  receipt_hash: string;
  evidence_hash: string;
  receipt: Receipt;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Signs the receipt for an event the HOST already persisted. The caller can only name the event:
 * stage, identity, severity, level... all come from the stored row, never from the request.
 * Idempotent per event; the same event with different content is a conflict, never an overwrite.
 */
export async function emitReceipt(d: Deps, eventId: string, expectedEvidenceHash?: string): Promise<EmitResult> {
  if (!UUID.test(eventId)) throw new ServiceError(400, "bad_event_id", "eventId must be a uuid");
  const client = await d.pool.connect();
  try {
    await client.query("BEGIN");
    await lockEvent(client, eventId);

    const ev = await getEvent(client, eventId);
    if (!ev) throw new ServiceError(404, "event_not_found", `no persisted event ${eventId}`);

    const evHash = evidenceHash(ev, d.environment);
    if (expectedEvidenceHash && expectedEvidenceHash !== evHash)
      throw new ServiceError(409, "evidence_mismatch", "stored evidence does not match expectedEvidenceHash");

    const existing = await getReceiptByEvent(client, eventId);
    if (existing) {
      if (existing.evidence_hash !== evHash)
        throw new ServiceError(409, "event_content_changed", "a receipt exists for this event but the evidence differs");
      await client.query("COMMIT");
      return { status: "existing", receipt_id: existing.receipt_id, receipt_hash: existing.receipt_hash, evidence_hash: evHash, receipt: existing.receipt as unknown as Receipt };
    }

    const problems = validateEvent(ev);
    if (problems.length) throw new ServiceError(422, "invalid_evidence", "event is not receiptable", problems);
    if (ev.stage === "fix") await checkApprovalReference(client, ev);

    const receipt = buildReceipt(ev, d.key, d.environment);
    const rHash = receiptHash(receipt);
    await insertReceipt(client, {
      receipt_id: receipt.receipt_id, event_id: ev.event_id, incident_id: ev.incident_id, stage: ev.stage,
      receipt: receipt as unknown as Record<string, unknown>, receipt_hash: rHash, evidence_hash: evHash, public_key_id: d.key.keyId,
    });
    await client.query("COMMIT");
    return { status: "created", receipt_id: receipt.receipt_id, receipt_hash: rHash, evidence_hash: evHash, receipt };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The fix receipt must point at a REAL approval receipt of the SAME incident for the SAME diagnosis.
 * This validates the evidence the fix receipt will bind; it is not what authorizes Phase 2 (n8n's
 * token/permission logic still is, see the plan).
 */
async function checkApprovalReference(client: pg.PoolClient, ev: StoredEvent): Promise<void> {
  const ref = String(ev.input_evidence.approval_receipt_id);
  const row = await getReceiptById(client, ref);
  const bad = (m: string) => new ServiceError(422, "bad_approval_reference", m);
  if (!row) throw bad("approval_receipt_id does not exist");
  if (row.stage !== "approval") throw bad("referenced receipt is not an approval receipt");
  if (row.incident_id !== ev.incident_id) throw bad("referenced approval belongs to a different incident");
  if (row.receipt_hash !== ev.input_evidence.approval_receipt_hash) throw bad("approval_receipt_hash does not match the stored receipt");
  const approvalEvent = await getEvent(client, row.event_id);
  if (!approvalEvent) throw bad("approval event missing");
  if (approvalEvent.input_evidence.action !== "approve") throw bad("referenced decision is not an approval");
  if (approvalEvent.input_evidence.diagnosis_hash !== ev.input_evidence.diagnosis_hash) throw bad("approval was for a different diagnosis version");
}

export async function readBundle(d: Deps, eventId: string) {
  if (!UUID.test(eventId)) throw new ServiceError(400, "bad_event_id", "eventId must be a uuid");
  const ev = await getEvent(d.pool, eventId);
  const row = await getReceiptByEvent(d.pool, eventId);
  if (!ev || !row) throw new ServiceError(404, "receipt_not_found", "no receipt for this event");
  return { receipt: row.receipt, receipt_hash: row.receipt_hash, event: ev, environment: d.environment };
}
