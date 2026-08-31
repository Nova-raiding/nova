-- migrate:no-transaction
-- Bounded merchant collection reads use deterministic sort keys and tenant-leading indexes.

CREATE INDEX CONCURRENTLY IF NOT EXISTS products_workspace_platform_account_updated_id_idx
  ON products (workspace_id, platform, platform_account_id, updated_at DESC, id ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_workspace_created_id_idx
  ON tasks (workspace_id, created_at DESC, id ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_workspace_brand_created_id_idx
  ON tasks (workspace_id, brand_id, created_at DESC, id ASC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_workspace_platform_state_created_id_idx
  ON tasks (workspace_id, platform, state, created_at DESC, id ASC);
