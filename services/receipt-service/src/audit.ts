import type pg from "pg";
import type { Receipt } from "../vendor/BoundaryAttest/src/receipts.js";
import type { StoredEvent } from "./evidence.js";
import { verifyBundle, type Bundle, type VerifyResult } from "./verify.js";

export type AuditItem = {
  event_id: string; stage: string; attempt: number;
  status: "verified" | "failed" | "pending";
  receipt_id?: string; problems?: string[]; detail?: VerifyResult;
};
export type AuditReport = { incident_id: number; items: AuditItem[]; verified: number; failed: number; pending: number; ok: boolean };

/**
 * Re-verifies, from the database alone, every event of one incident against the trusted keys.
 * `pending` = event recorded but no receipt yet (service was down; the reconciler will emit it).
 * ok means: nothing failed. Pending is reported, not hidden, and does not count as verified.
 */
export async function auditIncident(pool: pg.Pool, incidentId: number, trustedKeys: Record<string, string>, environment: string): Promise<AuditReport> {
  const events = (await pool.query(
    `SELECT event_id, incident_id, stage, attempt, action_status, input_evidence, output_evidence, tool_metadata, caller
       FROM incident_events WHERE incident_id = $1 ORDER BY created_at, event_id`, [incidentId])).rows as StoredEvent[];
  const receipts = (await pool.query("SELECT event_id, receipt_id, receipt FROM incident_receipts WHERE incident_id = $1", [incidentId])).rows as
    { event_id: string; receipt_id: string; receipt: Receipt }[];
  const byEvent = new Map(receipts.map((r) => [r.event_id, r]));
  const byReceiptId = new Map(receipts.map((r) => [r.receipt_id, r]));
  const evById = new Map(events.map((e) => [e.event_id, e]));

  const items: AuditItem[] = events.map((e) => {
    const r = byEvent.get(e.event_id);
    if (!r) return { event_id: e.event_id, stage: e.stage, attempt: e.attempt, status: "pending" as const };
    let approval: Bundle | undefined;
    if (e.stage === "fix") {
      const a = byReceiptId.get(String(e.input_evidence.approval_receipt_id));
      const ae = a && evById.get(a.event_id);
      if (a && ae) approval = { receipt: a.receipt, event: ae };
    }
    const detail = verifyBundle({ receipt: r.receipt, event: e }, { trustedKeys, environment, approval });
    return { event_id: e.event_id, stage: e.stage, attempt: e.attempt, status: detail.ok ? ("verified" as const) : ("failed" as const), receipt_id: r.receipt_id, problems: detail.problems, detail };
  });
  const count = (s: AuditItem["status"]) => items.filter((i) => i.status === s).length;
  return { incident_id: incidentId, items, verified: count("verified"), failed: count("failed"), pending: count("pending"), ok: count("failed") === 0 };
}
