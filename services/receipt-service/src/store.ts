import pg from "pg";
import type { StoredEvent } from "./evidence.js";

export type ReceiptRow = {
  receipt_id: string; event_id: string; incident_id: number; stage: string;
  receipt: Record<string, unknown>; receipt_hash: string; evidence_hash: string; public_key_id: string;
};

export function makePool(connectionString: string, schema?: string): pg.Pool {
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("invalid schema name");
  // search_path as a connection parameter (not a query on 'connect'): applied before any query runs
  return new pg.Pool({ connectionString, max: 5, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
}

const EVENT_COLS = "event_id, incident_id, stage, attempt, action_status, input_evidence, output_evidence, tool_metadata, caller";

export async function getEvent(db: pg.Pool | pg.PoolClient, eventId: string): Promise<StoredEvent | null> {
  const r = await db.query(`SELECT ${EVENT_COLS} FROM incident_events WHERE event_id::text = $1`, [eventId]);
  return (r.rows[0] as StoredEvent | undefined) ?? null;
}

export async function getReceiptByEvent(db: pg.Pool | pg.PoolClient, eventId: string): Promise<ReceiptRow | null> {
  const r = await db.query("SELECT * FROM incident_receipts WHERE event_id::text = $1", [eventId]);
  return (r.rows[0] as ReceiptRow | undefined) ?? null;
}

export async function getReceiptById(db: pg.Pool | pg.PoolClient, receiptId: string): Promise<ReceiptRow | null> {
  const r = await db.query("SELECT * FROM incident_receipts WHERE receipt_id::text = $1", [receiptId]);
  return (r.rows[0] as ReceiptRow | undefined) ?? null;
}

export async function insertReceipt(db: pg.PoolClient, row: Omit<ReceiptRow, "event_id"> & { event_id: string }): Promise<void> {
  await db.query(
    `INSERT INTO incident_receipts (receipt_id, event_id, incident_id, stage, receipt, receipt_hash, evidence_hash, public_key_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.receipt_id, row.event_id, row.incident_id, row.stage, JSON.stringify(row.receipt), row.receipt_hash, row.evidence_hash, row.public_key_id],
  );
}

/** Serializes concurrent emissions for the same event (advisory lock held until COMMIT/ROLLBACK). */
export async function lockEvent(db: pg.PoolClient, eventId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [eventId]);
}
