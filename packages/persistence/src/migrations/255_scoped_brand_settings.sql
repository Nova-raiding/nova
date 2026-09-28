-- Stable brand scope identities. A series is identified by its server ID, not
-- by its editable display name. Every image scope first belongs to one store.
CREATE TABLE merchant_brand_series (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  id TEXT NOT NULL,
  platform_account_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, platform_account_id, id),
  FOREIGN KEY (workspace_id, platform_account_id)
    REFERENCES platform_accounts(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX merchant_brand_series_store_idx ON merchant_brand_series(workspace_id, platform_account_id, name);
CREATE UNIQUE INDEX merchant_brand_series_store_name_unique ON merchant_brand_series(workspace_id, platform_account_id, lower(name));

CREATE TABLE merchant_brand_asset_assignments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL,
  asset_entity_type TEXT NOT NULL DEFAULT 'asset' CHECK (asset_entity_type = 'asset'),
  platform_account_id TEXT NOT NULL,
  series_id TEXT,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, asset_id),
  FOREIGN KEY (workspace_id, asset_entity_type, asset_id)
    REFERENCES business_entity_snapshots(workspace_id, entity_type, entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, platform_account_id)
    REFERENCES platform_accounts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, platform_account_id, series_id)
    REFERENCES merchant_brand_series(workspace_id, platform_account_id, id) ON DELETE RESTRICT
);

CREATE INDEX merchant_brand_asset_store_idx ON merchant_brand_asset_assignments(workspace_id, platform_account_id, series_id);

-- A single CAS revision protects the whole hierarchy from lost updates.
-- The API validates all referenced identities against the two tables above
-- and trusted asset snapshots in the same transaction before writing JSON.
CREATE TABLE merchant_brand_scoped_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  settings JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object' AND settings->'schemaVersion' = '1'::jsonb),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_actor_id TEXT NOT NULL CHECK (length(btrim(updated_by_actor_id)) BETWEEN 1 AND 255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE merchant_brand_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_brand_series FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_brand_series_workspace_isolation ON merchant_brand_series
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE merchant_brand_asset_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_brand_asset_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_brand_asset_assignments_workspace_isolation ON merchant_brand_asset_assignments
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE merchant_brand_scoped_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_brand_scoped_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_brand_scoped_settings_workspace_isolation ON merchant_brand_scoped_settings
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

REVOKE ALL ON merchant_brand_series, merchant_brand_asset_assignments, merchant_brand_scoped_settings FROM PUBLIC;
DO $merchant_brand_scope_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON merchant_brand_series, merchant_brand_asset_assignments, merchant_brand_scoped_settings TO merchant_app;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON merchant_brand_series, merchant_brand_asset_assignments, merchant_brand_scoped_settings FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON merchant_brand_series, merchant_brand_asset_assignments, merchant_brand_scoped_settings TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON merchant_brand_series, merchant_brand_asset_assignments, merchant_brand_scoped_settings FROM merchant_ops;
  END IF;
END
$merchant_brand_scope_acl$;
