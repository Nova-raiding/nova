-- Customer delivery belongs to the isolated ops role, including checklist
-- evidence and atomic audit inserts. No business records are removed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON workspace_customer_deliveries, workspace_customer_delivery_videos,
      workspace_customer_delivery_checklist_items FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT, UPDATE ON workspace_customer_deliveries,
      workspace_customer_delivery_checklist_items TO merchant_ops;
    GRANT SELECT, INSERT ON workspace_customer_delivery_videos TO merchant_ops;
    GRANT UPDATE (deleted_at) ON workspace_customer_delivery_videos TO merchant_ops;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON workspace_customer_deliveries,
      workspace_customer_delivery_videos, workspace_customer_delivery_checklist_items FROM merchant_ops;
    GRANT INSERT ON workspace_operation_audit TO merchant_ops;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON workspace_operation_audit FROM merchant_ops;
  END IF;
END $$;
