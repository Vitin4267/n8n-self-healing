import { hashValue } from "../vendor/BoundaryAttest/src/hash.js";
import type { Receipt } from "../vendor/BoundaryAttest/src/receipts.js";
import { AGENT_ID, lineageRefFor, receiptInput, toolFor, validateEvent, type StoredEvent } from "./evidence.js";
import { keyIdFor } from "./keys.js";
import { receiptHash, verifyReceipt } from "./receipt.js";

export type Bundle = { receipt: Receipt; event: StoredEvent };
export type VerifyContext = {
  trustedKeys: Record<string, string>; // key id -> public key PEM, from a channel you trust
  environment: string;
  approval?: Bundle; // required to verify a `fix` receipt's reference
};
export type VerifyResult = {
  ok: boolean;
  crypto_valid: boolean;
  key_trusted: boolean;
  evidence_consistent: boolean;
  references_consistent: boolean;
  problems: string[];
};

/**
 * Reports four things separately on purpose: a valid signature (crypto) from an unknown key proves
 * nothing about trust; consistent evidence says nothing about who may sign. What it does NOT prove:
 * that the phone/person is real, that the level or severity was right, or that n8n was uncompromised.
 */
export function verifyBundle(b: Bundle, ctx: VerifyContext): VerifyResult {
  const problems: string[] = [];
  const { receipt: r, event: ev } = b;

  const pem = ctx.trustedKeys[r.public_key_id];
  const key_trusted = !!pem && keyIdFor(pem) === r.public_key_id;
  if (!pem) problems.push(`unknown signing key ${r.public_key_id}`);
  else if (!key_trusted) problems.push("trusted key file does not hash to the claimed key id");

  let crypto_valid = false;
  if (pem) {
    try {
      crypto_valid = verifyReceipt(r, pem);
    } catch {
      crypto_valid = false;
    }
  }
  if (!crypto_valid) problems.push("signature does not verify for the receipt contents");

  const before = problems.length;
  const eq = (label: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got ?? null) !== JSON.stringify(want ?? null)) problems.push(`${label} mismatch`);
  };
  eq("tool", r.tool, toolFor(ev.stage));
  eq("agent_id", r.agent_id, AGENT_ID);
  eq("receipt_role", r.receipt_role, "server_attested");
  eq("action_status", r.action_status, ev.action_status);
  eq("input_hash (evidence/level/severity/identity)", r.input_hash, hashValue(receiptInput(ev, ctx.environment)));
  eq("output_hash", r.output_hash, ev.output_evidence == null ? null : hashValue(ev.output_evidence));
  eq("tool_metadata_hash", r.tool_metadata_hash, ev.tool_metadata == null ? undefined : hashValue(ev.tool_metadata));
  eq("caller_type", r.caller_type, ev.caller.type ?? "unknown");
  eq("caller_id", r.caller_id, ev.caller.id);
  eq("caller_auth_ref", r.caller_auth_ref, ev.caller.authRef);
  eq("lineage_ref", r.lineage_ref, lineageRefFor(ev.incident_id));
  eq("lineage_type", r.lineage_type, "workflow_run");
  for (const p of validateEvent(ev)) problems.push(`evidence rule: ${p}`);
  const evidence_consistent = problems.length === before;

  let references_consistent = true;
  if (ev.stage === "fix") {
    const refProblems: string[] = [];
    const a = ctx.approval;
    if (!a) refProblems.push("approval bundle not provided; cannot verify the fix's approval reference");
    else {
      const ar = verifyBundle({ receipt: a.receipt, event: a.event }, { ...ctx, approval: undefined });
      if (!ar.ok) refProblems.push(`referenced approval receipt does not verify (${ar.problems.join("; ")})`);
      if (a.receipt.receipt_id !== ev.input_evidence.approval_receipt_id) refProblems.push("approval_receipt_id does not match the supplied approval receipt");
      if (receiptHash(a.receipt) !== ev.input_evidence.approval_receipt_hash) refProblems.push("approval_receipt_hash does not match the supplied approval receipt");
      if (a.receipt.lineage_ref !== r.lineage_ref) refProblems.push("approval belongs to a different incident");
      if (a.event.stage !== "approval" || a.event.input_evidence.action !== "approve") refProblems.push("referenced receipt is not an approval decision");
      if (a.event.input_evidence.diagnosis_hash !== ev.input_evidence.diagnosis_hash) refProblems.push("approval was for a different diagnosis version");
    }
    references_consistent = refProblems.length === 0;
    problems.push(...refProblems);
  }

  return { ok: crypto_valid && key_trusted && evidence_consistent && references_consistent, crypto_valid, key_trusted, evidence_consistent, references_consistent, problems };
}
