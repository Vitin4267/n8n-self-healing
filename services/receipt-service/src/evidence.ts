import { hashValue } from "../vendor/BoundaryAttest/src/hash.js";

export type Stage = "triage" | "diagnosis" | "approval" | "fix";
export const STAGES: Stage[] = ["triage", "diagnosis", "approval", "fix"];
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const LEVELS = ["full", "partial", "junior"] as const;
export const CONTRACT_VERSION = "n8n-self-healing/1";
export const AGENT_ID = "n8n-self-healing";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Caller = { id?: string; type?: "human" | "agent" | "service" | "unknown"; authRef?: string };

export type StoredEvent = {
  event_id: string;
  incident_id: number;
  stage: Stage;
  attempt: number;
  action_status: "executed" | "failed";
  input_evidence: { [k: string]: Json };
  output_evidence: { [k: string]: Json } | null;
  tool_metadata: { [k: string]: Json } | null;
  caller: Caller;
};

export const toolFor = (stage: Stage) => `incident.${stage}`;
export const lineageRefFor = (incidentId: number) => `incident:${incidentId}`;

/** What BoundaryAttest hashes into `input_hash`: the evidence plus the identity of the event. */
export function receiptInput(ev: StoredEvent, environment: string) {
  return {
    contract_version: CONTRACT_VERSION,
    environment,
    event_id: ev.event_id,
    incident_id: ev.incident_id,
    stage: ev.stage,
    attempt: ev.attempt,
    evidence: ev.input_evidence,
  };
}

/** One hash over everything the receipt will vouch for; used to detect "same event, different content". */
export function evidenceHash(ev: StoredEvent, environment: string): string {
  return hashValue({
    input: receiptInput(ev, environment),
    output: ev.output_evidence ?? null,
    tool_metadata: ev.tool_metadata ?? null,
    caller: ev.caller,
    action_status: ev.action_status,
    lineage_ref: lineageRefFor(ev.incident_id),
  });
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The permission matrix (plan, phase 1). Evidence that contradicts it is rejected, not signed. */
export function mayApprove(level: string, severity: string): boolean {
  return level === "full" || (level === "partial" && severity === "low");
}

/** Returns a list of problems; empty means the event is well-formed for its stage. */
export function validateEvent(ev: StoredEvent): string[] {
  const e: string[] = [];
  const i = ev.input_evidence ?? {};
  const o = ev.output_evidence ?? {};
  if (!Number.isInteger(ev.incident_id) || ev.incident_id <= 0) e.push("incident_id must be a positive integer");

  const wantCaller = ev.stage === "approval" ? "human" : "service";
  if (ev.caller?.type !== wantCaller) e.push(`caller.type must be '${wantCaller}' for stage '${ev.stage}'`);

  switch (ev.stage) {
    case "triage":
      if (!(SEVERITIES as readonly string[]).includes(o.severity as string)) e.push("output.severity invalid");
      if (typeof o.escalate !== "boolean") e.push("output.escalate must be boolean");
      if (o.source !== "model" && o.source !== "fallback") e.push("output.source must be 'model' or 'fallback'");
      break;
    case "diagnosis":
      if (!HEX64.test(String(o.diagnosis_hash ?? ""))) e.push("output.diagnosis_hash must be sha256 hex");
      if (!Number.isInteger(o.diagnosis_version)) e.push("output.diagnosis_version must be an integer");
      break;
    case "approval": {
      if (!isStr(ev.caller?.id)) e.push("approval caller.id (approver) is required");
      if (!(LEVELS as readonly string[]).includes(i.permission_level as string)) e.push("input.permission_level invalid");
      if (!(SEVERITIES as readonly string[]).includes(i.severity as string)) e.push("input.severity invalid");
      if (i.action !== "approve" && i.action !== "reject") e.push("input.action must be 'approve' or 'reject'");
      if (!isStr(i.token_ref)) e.push("input.token_ref required");
      if (!HEX64.test(String(i.diagnosis_hash ?? ""))) e.push("input.diagnosis_hash must be sha256 hex");
      if (i.eligible !== true) e.push("input.eligible must be true (only accepted decisions are receipted)");
      if (i.token_consumed !== true) e.push("input.token_consumed must be true");
      else if (!mayApprove(String(i.permission_level), String(i.severity)))
        e.push(`evidence contradicts policy: level '${i.permission_level}' may not decide severity '${i.severity}'`);
      break;
    }
    case "fix":
      if (!UUID.test(String(i.approval_receipt_id ?? ""))) e.push("input.approval_receipt_id must be a uuid");
      if (!HEX64.test(String(i.approval_receipt_hash ?? ""))) e.push("input.approval_receipt_hash must be sha256 hex");
      if (!HEX64.test(String(i.diagnosis_hash ?? ""))) e.push("input.diagnosis_hash must be sha256 hex");
      if (!["pr_created", "aborted", "needs_manual_review"].includes(String(o.status))) e.push("output.status invalid");
      break;
  }
  return e;
}
