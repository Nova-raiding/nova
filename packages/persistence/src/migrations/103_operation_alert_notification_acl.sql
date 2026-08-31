-- Preserve migration 100's immutable checksum while making its runtime ledger
-- explicitly writable only through the bounded application role.
REVOKE ALL ON TABLE workspace_operation_alert_notifications FROM PUBLIC;
DO $workspace_operation_alert_notification_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE workspace_operation_alert_notifications TO merchant_app;
    REVOKE DELETE,TRUNCATE ON TABLE workspace_operation_alert_notifications FROM merchant_app;
  END IF;
END
$workspace_operation_alert_notification_acl$;
