ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_id_workspace_unique UNIQUE (id,workspace_id);

CREATE TABLE IF NOT EXISTS asset_scan_attempts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  outbox_event_id TEXT NOT NULL,
  asset_source_revision INTEGER NOT NULL CHECK (asset_source_revision > 0),
  receipt_id TEXT NOT NULL UNIQUE,
  receipt_digest TEXT NOT NULL UNIQUE CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  signature TEXT NOT NULL,
  canonical_receipt TEXT NOT NULL,
  receipt JSONB NOT NULL,
  callback_body TEXT NOT NULL,
  callback_status TEXT NOT NULL DEFAULT 'pending' CHECK (callback_status IN ('pending','accepted')),
  callback_attempts INTEGER NOT NULL DEFAULT 0 CHECK (callback_attempts >= 0),
  last_callback_at TIMESTAMPTZ,
  last_callback_error TEXT,
  callback_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_event_id,asset_source_revision),
  CONSTRAINT asset_scan_attempts_outbox_workspace_fk
    FOREIGN KEY (outbox_event_id,workspace_id) REFERENCES outbox_events(id,workspace_id),
  CONSTRAINT asset_scan_attempts_receipt_binding CHECK (
    canonical_receipt::jsonb = receipt
    AND receipt->>'receipt_id' IS NOT DISTINCT FROM receipt_id
    AND receipt->>'scan_job_id' IS NOT DISTINCT FROM outbox_event_id
    AND receipt->'subject'->>'workspace_id' IS NOT DISTINCT FROM workspace_id
    AND (receipt->'subject'->>'asset_source_revision')::INTEGER IS NOT DISTINCT FROM asset_source_revision
    AND callback_body::jsonb = jsonb_build_object('receipt',receipt,'signature',signature)
  ),
  CONSTRAINT asset_scan_attempts_callback_state CHECK (
    (callback_status = 'pending' AND callback_accepted_at IS NULL)
    OR (callback_status = 'accepted' AND callback_accepted_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS asset_scan_attempts_workspace_event_idx
  ON asset_scan_attempts (workspace_id,outbox_event_id);

ALTER TABLE asset_scan_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_scan_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asset_scan_attempts_workspace_isolation ON asset_scan_attempts;
CREATE POLICY asset_scan_attempts_workspace_isolation ON asset_scan_attempts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION enforce_asset_scan_attempt_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $asset_scan_attempt_transition$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset scan attempts are durable and cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF (NEW.workspace_id,NEW.outbox_event_id,NEW.asset_source_revision,NEW.receipt_id,NEW.receipt_digest,NEW.signature,NEW.canonical_receipt,NEW.receipt,NEW.callback_body,NEW.created_at)
     IS DISTINCT FROM
     (OLD.workspace_id,OLD.outbox_event_id,OLD.asset_source_revision,OLD.receipt_id,OLD.receipt_digest,OLD.signature,OLD.canonical_receipt,OLD.receipt,OLD.callback_body,OLD.created_at) THEN
    RAISE EXCEPTION 'asset scan attempt evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.callback_status = 'accepted' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'accepted asset scan callback is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.callback_attempts < OLD.callback_attempts THEN
    RAISE EXCEPTION 'asset scan callback attempts cannot decrease' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$asset_scan_attempt_transition$;

DROP TRIGGER IF EXISTS asset_scan_attempts_transition ON asset_scan_attempts;
CREATE TRIGGER asset_scan_attempts_transition
BEFORE INSERT OR UPDATE OR DELETE ON asset_scan_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_asset_scan_attempt_transition();

REVOKE ALL ON TABLE asset_scan_attempts FROM PUBLIC;
DO $asset_scan_attempts_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE asset_scan_attempts FROM merchant_app;
    GRANT SELECT, INSERT ON TABLE asset_scan_attempts TO merchant_app;
    GRANT UPDATE (callback_status,callback_attempts,last_callback_at,last_callback_error,callback_accepted_at) ON TABLE asset_scan_attempts TO merchant_app;
    REVOKE DELETE, TRUNCATE ON TABLE asset_scan_attempts FROM merchant_app;
  END IF;
END
$asset_scan_attempts_grants$;
