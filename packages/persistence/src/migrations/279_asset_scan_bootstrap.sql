-- 279_asset_scan_bootstrap: safely enroll historical unscanned quarantine
-- assets into the existing signed scanner and continuation pipeline.

CREATE TABLE IF NOT EXISTS asset_scan_bootstraps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  recovery_key TEXT NOT NULL CHECK (recovery_key = btrim(recovery_key) AND length(recovery_key) BETWEEN 8 AND 255 AND recovery_key !~ '[[:cntrl:]]'),
  asset_id TEXT NOT NULL,
  expected_asset_revision INTEGER NOT NULL CHECK (expected_asset_revision > 0),
  source_revision_before INTEGER NOT NULL CHECK (source_revision_before > 0),
  source_revision_after INTEGER NOT NULL CHECK (source_revision_after = source_revision_before + 1),
  actor_id TEXT NOT NULL CHECK (actor_id = btrim(actor_id) AND length(actor_id) BETWEEN 1 AND 255 AND actor_id !~ '[[:cntrl:]]'),
  reason TEXT NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 3 AND 1000 AND reason !~ '[[:cntrl:]]'),
  new_outbox_event_id TEXT NOT NULL,
  audit_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,recovery_key),
  UNIQUE (workspace_id,new_outbox_event_id),
  FOREIGN KEY (new_outbox_event_id,workspace_id) REFERENCES outbox_events(id,workspace_id),
  FOREIGN KEY (audit_id,workspace_id) REFERENCES workspace_operation_audit(id,workspace_id)
);

ALTER TABLE asset_scan_bootstraps ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_scan_bootstraps FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_scan_bootstraps_workspace_isolation ON asset_scan_bootstraps
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_asset_scan_bootstrap_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $asset_scan_bootstrap_immutable$
BEGIN
  RAISE EXCEPTION 'asset scan bootstrap evidence is immutable and cannot be deleted' USING ERRCODE = '55000';
END;
$asset_scan_bootstrap_immutable$;

CREATE TRIGGER asset_scan_bootstraps_immutable
BEFORE UPDATE OR DELETE ON asset_scan_bootstraps
FOR EACH ROW EXECUTE FUNCTION reject_asset_scan_bootstrap_mutation();

CREATE TRIGGER asset_scan_bootstraps_no_truncate
BEFORE TRUNCATE ON asset_scan_bootstraps
FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_truncate();

-- Owner default privileges may grant UPDATE on new tables. Reset them before
-- granting the append-only runtime surface, as for asset_scan_redrives.
REVOKE ALL ON TABLE asset_scan_bootstraps FROM PUBLIC, merchant_app, merchant_ops;
GRANT SELECT, INSERT ON TABLE asset_scan_bootstraps TO merchant_app;
