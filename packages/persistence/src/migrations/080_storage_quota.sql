-- 080_storage_quota: workspace-scoped logical object-byte quota ledger.
-- Quarantine -> clean promotion does not create a second logical reservation.

CREATE TABLE IF NOT EXISTS workspace_storage_quotas (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  limit_bytes bigint NOT NULL CHECK (limit_bytes >= 0),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (used_bytes + reserved_bytes >= 0)
);

CREATE TABLE IF NOT EXISTS storage_quota_reservations (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reservation_key text NOT NULL CHECK (length(btrim(reservation_key)) BETWEEN 1 AND 512),
  asset_id text NOT NULL CHECK (length(btrim(asset_id)) BETWEEN 1 AND 256),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
  actual_bytes bigint CHECK (actual_bytes IS NULL OR actual_bytes >= 0),
  status text NOT NULL CHECK (status IN ('active','settled','released','over_limit')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,reservation_key),
  CHECK (
    (status IN ('active','released') AND actual_bytes IS NULL)
    OR (status IN ('settled','over_limit') AND actual_bytes IS NOT NULL)
  ),
  CHECK (status = 'active' OR reserved_bytes = 0)
);

ALTER TABLE workspace_storage_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_storage_quotas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_storage_quotas_workspace_isolation ON workspace_storage_quotas;
CREATE POLICY workspace_storage_quotas_workspace_isolation ON workspace_storage_quotas
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE storage_quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_quota_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS storage_quota_reservations_workspace_isolation ON storage_quota_reservations;
CREATE POLICY storage_quota_reservations_workspace_isolation ON storage_quota_reservations
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- The application role may operate only through the workspace-scoped repository;
-- it must not own the tables or bypass RLS.
GRANT SELECT, INSERT, UPDATE ON workspace_storage_quotas TO merchant_app;
GRANT SELECT, INSERT, UPDATE ON storage_quota_reservations TO merchant_app;
