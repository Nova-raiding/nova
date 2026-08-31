-- Durable phase-2 cleanup after a trusted scan promotion commits. The row
-- retains the complete object/receipt binding so retries never delete by an
-- unverified key alone.
ALTER TABLE asset_scan_receipts
  DROP CONSTRAINT IF EXISTS asset_scan_receipts_id_workspace_unique;
ALTER TABLE asset_scan_receipts
  ADD CONSTRAINT asset_scan_receipts_id_workspace_unique UNIQUE (receipt_id,workspace_id);

CREATE TABLE IF NOT EXISTS asset_promotion_cleanup_tasks (
  cleanup_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  receipt_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_source_revision INTEGER NOT NULL CHECK (asset_source_revision > 0),
  quarantine_key TEXT NOT NULL,
  clean_key TEXT NOT NULL,
  scan_evidence_ref TEXT NOT NULL,
  object_sha256 TEXT NOT NULL CHECK (object_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  ready_outbox_event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  last_error JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_promotion_cleanup_receipt_fk
    FOREIGN KEY (receipt_id,workspace_id) REFERENCES asset_scan_receipts(receipt_id,workspace_id),
  CONSTRAINT asset_promotion_cleanup_outbox_fk
    FOREIGN KEY (ready_outbox_event_id,workspace_id) REFERENCES outbox_events(id,workspace_id),
  CONSTRAINT asset_promotion_cleanup_asset_revision_unique
    UNIQUE (workspace_id,asset_id,asset_source_revision),
  CONSTRAINT asset_promotion_cleanup_receipt_unique UNIQUE (workspace_id,receipt_id),
  CONSTRAINT asset_promotion_cleanup_binding CHECK (
    quarantine_key LIKE 'quarantine/' || workspace_id || '/%'
    AND clean_key LIKE 'clean/' || workspace_id || '/%'
    AND scan_evidence_ref LIKE 'scan-receipt://' || receipt_id || '/%'
  ),
  CONSTRAINT asset_promotion_cleanup_state CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS asset_promotion_cleanup_pending_idx
  ON asset_promotion_cleanup_tasks (workspace_id,next_attempt_at,created_at)
  WHERE status = 'pending';

ALTER TABLE asset_promotion_cleanup_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_promotion_cleanup_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_promotion_cleanup_workspace_isolation ON asset_promotion_cleanup_tasks;
CREATE POLICY asset_promotion_cleanup_workspace_isolation ON asset_promotion_cleanup_tasks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION protect_asset_promotion_cleanup_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $asset_promotion_cleanup_binding$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset promotion cleanup tasks cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.cleanup_id IS DISTINCT FROM OLD.cleanup_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.asset_source_revision IS DISTINCT FROM OLD.asset_source_revision
     OR NEW.quarantine_key IS DISTINCT FROM OLD.quarantine_key
     OR NEW.clean_key IS DISTINCT FROM OLD.clean_key
     OR NEW.scan_evidence_ref IS DISTINCT FROM OLD.scan_evidence_ref
     OR NEW.object_sha256 IS DISTINCT FROM OLD.object_sha256
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.ready_outbox_event_id IS DISTINCT FROM OLD.ready_outbox_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'asset promotion cleanup binding is immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$asset_promotion_cleanup_binding$;

DROP TRIGGER IF EXISTS asset_promotion_cleanup_binding_immutable ON asset_promotion_cleanup_tasks;
CREATE TRIGGER asset_promotion_cleanup_binding_immutable
BEFORE UPDATE OR DELETE ON asset_promotion_cleanup_tasks
FOR EACH ROW EXECUTE FUNCTION protect_asset_promotion_cleanup_binding();

REVOKE ALL ON TABLE asset_promotion_cleanup_tasks FROM PUBLIC;
DO $asset_promotion_cleanup_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE asset_promotion_cleanup_tasks TO merchant_app;
    REVOKE DELETE,TRUNCATE ON TABLE asset_promotion_cleanup_tasks FROM merchant_app;
  END IF;
END
$asset_promotion_cleanup_grants$;
