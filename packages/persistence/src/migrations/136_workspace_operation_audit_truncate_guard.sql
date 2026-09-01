-- 136_workspace_operation_audit_truncate_guard: close the owner-level
-- mutation path left by the audit center append-only contract.
CREATE OR REPLACE FUNCTION reject_workspace_operation_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workspace operation audit is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS workspace_operation_audit_no_truncate
  ON workspace_operation_audit;
CREATE TRIGGER workspace_operation_audit_no_truncate
BEFORE TRUNCATE ON workspace_operation_audit
FOR EACH STATEMENT EXECUTE FUNCTION reject_workspace_operation_audit_mutation();

REVOKE TRUNCATE ON workspace_operation_audit FROM PUBLIC;
DO $workspace_operation_audit_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE TRUNCATE ON workspace_operation_audit FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE TRUNCATE ON workspace_operation_audit FROM merchant_ops;
  END IF;
END
$workspace_operation_audit_acl$;
