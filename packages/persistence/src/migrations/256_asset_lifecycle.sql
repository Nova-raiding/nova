-- Durable soft-delete state for merchant assets. The original asset snapshot
-- and linked evidence remain intact; this table only controls visibility and
-- the seven-day retention window.
CREATE TABLE merchant_asset_lifecycle (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL,
  deleted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  deleted_by TEXT,
  purge_requested_at TIMESTAMPTZ,
  purge_requested_by TEXT,
  purge_request_reason TEXT,
  restored_at TIMESTAMPTZ,
  restored_by TEXT,
  purged_at TIMESTAMPTZ,
  purge_lease_token TEXT,
  purge_lease_until TIMESTAMPTZ,
  purge_attempts INTEGER NOT NULL DEFAULT 0 CHECK (purge_attempts >= 0),
  purge_error JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, asset_id),
  CHECK ((deleted_at IS NULL) = (expires_at IS NULL)),
  CHECK ((purge_requested_at IS NULL) = (purge_requested_by IS NULL)),
  CHECK ((purge_requested_at IS NULL) = (purge_request_reason IS NULL)),
  CHECK (purged_at IS NULL OR deleted_at IS NOT NULL)
);
CREATE INDEX merchant_asset_lifecycle_trash_idx
  ON merchant_asset_lifecycle (workspace_id, deleted_at DESC, asset_id)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX merchant_asset_lifecycle_expiry_idx
  ON merchant_asset_lifecycle (expires_at, workspace_id, asset_id)
  WHERE expires_at IS NOT NULL AND purged_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_merchant_asset_lifecycle_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_entity_snapshots
    WHERE workspace_id = NEW.workspace_id AND entity_type = 'asset' AND entity_id = NEW.asset_id
    FOR KEY SHARE
  ) THEN
    RAISE EXCEPTION 'asset lifecycle requires an asset snapshot in the same workspace'
      USING ERRCODE = '23503', CONSTRAINT = 'merchant_asset_lifecycle_asset_snapshot_fk';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER merchant_asset_lifecycle_asset_snapshot_guard
  BEFORE INSERT OR UPDATE OF workspace_id, asset_id ON merchant_asset_lifecycle
  FOR EACH ROW EXECUTE FUNCTION enforce_merchant_asset_lifecycle_snapshot();

-- Asset snapshots are the durable source record required by restore and purge
-- reconciliation. Prevent legacy snapshot deletion from orphaning lifecycle
-- rows. The FK-style key-share lock above serializes lifecycle creation with
-- concurrent snapshot deletion.
CREATE OR REPLACE FUNCTION restrict_asset_snapshot_delete_with_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.entity_type = 'asset' AND EXISTS (
    SELECT 1 FROM merchant_asset_lifecycle
    WHERE workspace_id = OLD.workspace_id AND asset_id = OLD.entity_id
  ) THEN
    RAISE EXCEPTION 'asset snapshot is retained while lifecycle state exists'
      USING ERRCODE = '23503', CONSTRAINT = 'merchant_asset_lifecycle_asset_snapshot_fk';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER merchant_asset_lifecycle_snapshot_delete_guard
  BEFORE DELETE ON business_entity_snapshots
  FOR EACH ROW EXECUTE FUNCTION restrict_asset_snapshot_delete_with_lifecycle();

CREATE TABLE merchant_asset_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('deleted', 'restored', 'early_purge_requested', 'purge_request_cancelled', 'purge_claimed', 'purge_failed', 'purged')),
  actor_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX merchant_asset_lifecycle_events_asset_idx
  ON merchant_asset_lifecycle_events (workspace_id, asset_id, occurred_at, event_id);

ALTER TABLE merchant_asset_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_asset_lifecycle FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_asset_lifecycle_workspace_isolation ON merchant_asset_lifecycle
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
ALTER TABLE merchant_asset_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_asset_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_asset_lifecycle_events_workspace_isolation ON merchant_asset_lifecycle_events
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_merchant_asset_lifecycle_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'merchant_asset_lifecycle_events is append-only';
END
$$;
CREATE TRIGGER merchant_asset_lifecycle_events_append_only
  BEFORE UPDATE OR DELETE ON merchant_asset_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION reject_merchant_asset_lifecycle_event_mutation();

REVOKE ALL ON merchant_asset_lifecycle, merchant_asset_lifecycle_events FROM PUBLIC;
DO $asset_lifecycle_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON merchant_asset_lifecycle TO merchant_app;
    GRANT SELECT, INSERT ON merchant_asset_lifecycle_events TO merchant_app;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON merchant_asset_lifecycle, merchant_asset_lifecycle_events FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON merchant_asset_lifecycle, merchant_asset_lifecycle_events TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON merchant_asset_lifecycle, merchant_asset_lifecycle_events FROM merchant_ops;
  END IF;
END
$asset_lifecycle_acl$;
