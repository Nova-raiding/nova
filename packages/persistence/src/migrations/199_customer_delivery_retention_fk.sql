-- 199_customer_delivery_retention_fk: retain delivery records when a
-- workspace is removed. Workspace deactivation is the supported lifecycle;
-- customer-delivery metadata must never disappear through an implicit FK
-- cascade. Any eventual data deletion must go through the reviewed,
-- auditable data-lifecycle workflow.

ALTER TABLE workspace_customer_deliveries
  DROP CONSTRAINT IF EXISTS workspace_customer_deliveries_workspace_id_fkey;

ALTER TABLE workspace_customer_deliveries
  ADD CONSTRAINT workspace_customer_deliveries_workspace_id_fkey
  FOREIGN KEY (workspace_id)
  REFERENCES workspaces(id)
  ON DELETE RESTRICT;
