-- Receipt ledger. Idempotent (safe to re-run). Unqualified names: the caller picks the schema
-- through search_path (tests use a throwaway schema).
--
-- incident_events   evidence the HOST (n8n) persisted BEFORE asking for a receipt. Immutable.
-- incident_receipts the signed receipt for exactly one event. Immutable, one per event.

CREATE TABLE IF NOT EXISTS incident_events (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id     integer NOT NULL,
  stage           text NOT NULL CHECK (stage IN ('triage','diagnosis','approval','fix')),
  attempt         integer NOT NULL DEFAULT 1,
  action_status   text NOT NULL DEFAULT 'executed' CHECK (action_status IN ('executed','failed')),
  input_evidence  jsonb NOT NULL,
  output_evidence jsonb,
  tool_metadata   jsonb,
  caller          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, stage, attempt)
);

CREATE TABLE IF NOT EXISTS incident_receipts (
  receipt_id     uuid PRIMARY KEY,
  event_id       uuid NOT NULL UNIQUE REFERENCES incident_events(event_id),
  incident_id    integer NOT NULL,
  stage          text NOT NULL,
  receipt        jsonb NOT NULL,
  receipt_hash   text NOT NULL,
  evidence_hash  text NOT NULL,
  public_key_id  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receipts_incident ON incident_receipts (incident_id, stage);

-- Append-only: nobody (not even the table owner by accident) rewrites evidence or receipts.
CREATE OR REPLACE FUNCTION receipt_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS incident_events_append_only ON incident_events;
CREATE TRIGGER incident_events_append_only BEFORE UPDATE OR DELETE ON incident_events
  FOR EACH ROW EXECUTE FUNCTION receipt_ledger_append_only();
DROP TRIGGER IF EXISTS incident_events_no_truncate ON incident_events;
CREATE TRIGGER incident_events_no_truncate BEFORE TRUNCATE ON incident_events
  FOR EACH STATEMENT EXECUTE FUNCTION receipt_ledger_append_only();

DROP TRIGGER IF EXISTS incident_receipts_append_only ON incident_receipts;
CREATE TRIGGER incident_receipts_append_only BEFORE UPDATE OR DELETE ON incident_receipts
  FOR EACH ROW EXECUTE FUNCTION receipt_ledger_append_only();
DROP TRIGGER IF EXISTS incident_receipts_no_truncate ON incident_receipts;
CREATE TRIGGER incident_receipts_no_truncate BEFORE TRUNCATE ON incident_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION receipt_ledger_append_only();
