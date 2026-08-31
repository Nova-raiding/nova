-- 109_asset_scan_redrive: preserve terminal scanner evidence and create a new,
-- tenant-scoped scan generation for an operator-approved redrive.

CREATE OR REPLACE FUNCTION enforce_outbox_event_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $outbox_event_evidence_immutable$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbox events are durable and cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal outbox evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id,NEW.workspace_id,NEW.aggregate_id,NEW.event_type,NEW.sequence,NEW.payload,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.workspace_id,OLD.aggregate_id,OLD.event_type,OLD.sequence,OLD.payload,OLD.created_at) THEN
    RAISE EXCEPTION 'outbox event identity and payload are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$outbox_event_evidence_immutable$;

DROP TRIGGER IF EXISTS outbox_event_evidence_immutable ON outbox_events;
CREATE TRIGGER outbox_event_evidence_immutable
BEFORE UPDATE OR DELETE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION enforce_outbox_event_evidence_immutable();

CREATE OR REPLACE FUNCTION reject_evidence_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $evidence_truncate_forbidden$
BEGIN
  RAISE EXCEPTION 'durable evidence cannot be truncated' USING ERRCODE = '55000';
END;
$evidence_truncate_forbidden$;

DROP TRIGGER IF EXISTS outbox_events_no_truncate ON outbox_events;
CREATE TRIGGER outbox_events_no_truncate
BEFORE TRUNCATE ON outbox_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_truncate();

CREATE UNIQUE INDEX IF NOT EXISTS workspace_operation_audit_id_workspace_unique
  ON workspace_operation_audit (id,workspace_id);

CREATE TABLE IF NOT EXISTS asset_scan_redrives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  recovery_key TEXT NOT NULL CHECK (recovery_key = btrim(recovery_key) AND length(recovery_key) BETWEEN 8 AND 255 AND recovery_key !~ '[[:cntrl:]]'),
  asset_id TEXT NOT NULL,
  old_outbox_event_id TEXT NOT NULL,
  new_outbox_event_id TEXT NOT NULL,
  expected_asset_revision INTEGER NOT NULL CHECK (expected_asset_revision > 0),
  source_revision_before INTEGER NOT NULL CHECK (source_revision_before > 0),
  source_revision_after INTEGER NOT NULL CHECK (source_revision_after = source_revision_before + 1),
  actor_id TEXT NOT NULL CHECK (actor_id = btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255 AND actor_id !~ '[[:cntrl:]]'),
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000 AND reason !~ '[[:cntrl:]]'),
  scan_max_attempts INTEGER NOT NULL CHECK (scan_max_attempts > 0),
  audit_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,recovery_key),
  UNIQUE (workspace_id,old_outbox_event_id),
  UNIQUE (workspace_id,new_outbox_event_id),
  FOREIGN KEY (old_outbox_event_id,workspace_id) REFERENCES outbox_events(id,workspace_id),
  FOREIGN KEY (new_outbox_event_id,workspace_id) REFERENCES outbox_events(id,workspace_id),
  FOREIGN KEY (audit_id,workspace_id) REFERENCES workspace_operation_audit(id,workspace_id)
);

ALTER TABLE asset_scan_redrives ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_scan_redrives FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_scan_redrives_workspace_isolation ON asset_scan_redrives
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_asset_scan_redrive_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $asset_scan_redrive_immutable$
BEGIN
  RAISE EXCEPTION 'asset scan redrive evidence is immutable and cannot be deleted' USING ERRCODE = '55000';
END;
$asset_scan_redrive_immutable$;

CREATE TRIGGER asset_scan_redrives_immutable
BEFORE UPDATE OR DELETE ON asset_scan_redrives
FOR EACH ROW EXECUTE FUNCTION reject_asset_scan_redrive_mutation();

CREATE TRIGGER asset_scan_redrives_no_truncate
BEFORE TRUNCATE ON asset_scan_redrives
FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_truncate();

REVOKE ALL ON TABLE asset_scan_redrives FROM PUBLIC;
DO $asset_scan_redrive_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE outbox_events FROM merchant_app;
    GRANT UPDATE (published_at,attempts,next_attempt_at,lease_token,lease_until,last_error,unknown_at) ON TABLE outbox_events TO merchant_app;
    REVOKE ALL ON TABLE asset_scan_redrives FROM merchant_app;
    GRANT SELECT, INSERT ON TABLE asset_scan_redrives TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE asset_scan_redrives FROM merchant_app;
  END IF;
END
$asset_scan_redrive_acl$;
