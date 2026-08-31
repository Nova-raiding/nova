-- 071_runtime_integrity: repair databases created from the pre-release
-- migration catalog and close the tenant boundary on rollout overrides.
-- Never rewrite schema_migrations history: the idempotent statements below
-- make the current schema converge even when version 014 was recorded under
-- the historical read_only_schedules name.

ALTER TABLE platform_accounts
  ADD COLUMN IF NOT EXISTS store_alias text,
  ADD COLUMN IF NOT EXISTS authorization_revision integer NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS platform_accounts_store_alias_unique
  ON platform_accounts (workspace_id, platform, lower(store_alias))
  WHERE store_alias IS NOT NULL;

ALTER TABLE commercial_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_rollouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commercial_rollouts_workspace_isolation ON commercial_rollouts;
CREATE POLICY commercial_rollouts_workspace_isolation ON commercial_rollouts
  USING (workspace_id = '' OR workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = '' OR workspace_id = current_setting('app.workspace_id', true));
