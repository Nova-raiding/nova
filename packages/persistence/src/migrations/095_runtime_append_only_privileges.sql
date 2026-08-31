REVOKE DELETE, TRUNCATE ON TABLE
  action_ledger,
  model_usage_ledger,
  workspace_operation_audit,
  asset_scan_receipts,
  asset_scan_attempts,
  asset_promotion_cleanup_tasks,
  workspace_reconciliation_status
FROM merchant_app;

ALTER DEFAULT PRIVILEGES FOR ROLE merchant REVOKE DELETE, TRUNCATE ON TABLES FROM merchant_app;
