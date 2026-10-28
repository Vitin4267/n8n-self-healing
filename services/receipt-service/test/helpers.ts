import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { StoredEvent } from "../src/evidence.js";
import { generateKey, type SigningKey } from "../src/keys.js";
import { getEvent, makePool } from "../src/store.js";

export const ENV = "test";
export const tmp = (p = "rs-") => mkdtempSync(join(tmpdir(), p));
export const H = (c: string) => c.repeat(64).slice(0, 64);
export const newKey = (): SigningKey => generateKey(join(tmp(), "keys"));

export const TEST_DB = process.env.RECEIPT_TEST_DB_URL;
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(here, "../../migrations/001_receipts.sql"), "utf8");

/** Throwaway schema in the real Postgres; dropped afterwards. */
export async function setupDb(): Promise<{ pool: pg.Pool; schema: string; cleanup: () => Promise<void> }> {
  if (!TEST_DB) throw new Error("RECEIPT_TEST_DB_URL not set");
  const schema = `rs_test_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await admin.query(MIGRATION);
  await admin.end();
  const pool = makePool(TEST_DB, schema);
  return {
    pool, schema,
    cleanup: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DB });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}

export const CALLER_SVC = { id: "n8n:AZWei6MYYJDihsBi", type: "service", authRef: "n8n-workflow" } as const;
export const DIAG = H("d");

type Over = Partial<Pick<StoredEvent, "input_evidence" | "output_evidence" | "tool_metadata" | "caller" | "action_status" | "attempt">>;

/** Well-formed evidence per stage; `over` replaces whole fields. */
export function sample(stage: StoredEvent["stage"], incident: number, over: Over = {}): Omit<StoredEvent, "event_id"> {
  const base: Record<string, Omit<StoredEvent, "event_id">> = {
    triage: { incident_id: incident, stage: "triage", attempt: 1, action_status: "executed",
      input_evidence: { fingerprint: "f1", workflow_id: "w1", node_name: "Boom", model: "gpt-4o-mini", prompt_version: "v1" },
      output_evidence: { severity: "high", escalate: true, reason: "r", source: "model" }, tool_metadata: { model: "gpt-4o-mini" }, caller: { ...CALLER_SVC } },
    diagnosis: { incident_id: incident, stage: "diagnosis", attempt: 1, action_status: "executed",
      input_evidence: { source_commit: "a".repeat(40), workflow_snapshot_hash: H("b"), prompt_version: "v1", allowlist: "Read,Grep,Glob" },
      output_evidence: { diagnosis_hash: DIAG, diagnosis_version: 1, root_cause: "x" }, tool_metadata: null, caller: { ...CALLER_SVC } },
    approval: { incident_id: incident, stage: "approval", attempt: 1, action_status: "executed",
      input_evidence: { approver_id: 1, permission_level: "full", severity: "high", capability: "approve", action: "approve", eligible: true, token_consumed: true, token_ref: "7", diagnosis_hash: DIAG, policy_version: "p1" },
      output_evidence: { decision: "accepted" }, tool_metadata: null, caller: { id: "approver:1", type: "human", authRef: "approval-link-token" } },
    fix: { incident_id: incident, stage: "fix", attempt: 1, action_status: "executed",
      input_evidence: { approval_receipt_id: "00000000-0000-4000-8000-000000000000", approval_receipt_hash: H("c"), diagnosis_hash: DIAG, allowlist: "Edit,Write" },
      output_evidence: { status: "pr_created", branch: `fix/incident-${incident}`, pr_url: "https://example.test/pr/1" }, tool_metadata: null, caller: { ...CALLER_SVC } },
  };
  return { ...base[stage], ...over } as Omit<StoredEvent, "event_id">;
}

export async function insertEvent(pool: pg.Pool, ev: Omit<StoredEvent, "event_id">): Promise<StoredEvent> {
  const r = await pool.query(
    `INSERT INTO incident_events (incident_id, stage, attempt, action_status, input_evidence, output_evidence, tool_metadata, caller)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING event_id`,
    [ev.incident_id, ev.stage, ev.attempt, ev.action_status, JSON.stringify(ev.input_evidence), ev.output_evidence == null ? null : JSON.stringify(ev.output_evidence), ev.tool_metadata == null ? null : JSON.stringify(ev.tool_metadata), JSON.stringify(ev.caller)],
  );
  return (await getEvent(pool, r.rows[0].event_id))!;
}
