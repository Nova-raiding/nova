-- 132_rule_audit_append_only_acl: close the remaining database mutation path
-- for the tenant-scoped rule audit ledger. Corrections are new events; audit
-- history must never be rewritten or truncated by a runtime role or owner.

CREATE OR REPLACE FUNCTION reject_rule_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rule audit events are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS rule_audit_events_append_only ON rule_audit_events;
CREATE TRIGGER rule_audit_events_append_only
BEFORE UPDATE OR DELETE ON rule_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_rule_audit_mutation();

DROP TRIGGER IF EXISTS rule_audit_events_no_truncate ON rule_audit_events;
CREATE TRIGGER rule_audit_events_no_truncate
BEFORE TRUNCATE ON rule_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_rule_audit_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON rule_audit_events FROM PUBLIC;
DO $rule_audit_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON rule_audit_events FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON rule_audit_events FROM merchant_ops;
  END IF;
END
$rule_audit_acl$;
