-- 214_customer_delivery_archival: recoverable removal from the active delivery list.

ALTER TABLE workspace_customer_deliveries
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by_actor_id TEXT;

DROP INDEX IF EXISTS customer_deliveries_workspace_company_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS customer_deliveries_workspace_active_company_unique_idx
  ON workspace_customer_deliveries(workspace_id, lower(btrim(company_name)))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS customer_deliveries_workspace_archived_idx
  ON workspace_customer_deliveries(workspace_id, archived_at, updated_at DESC, id DESC);
