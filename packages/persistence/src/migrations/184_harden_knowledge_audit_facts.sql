-- 184_harden_knowledge_audit_facts: index lifecycle events and deletion
-- proofs are audit facts. They may be appended by the tenant runtime, but
-- must never be rewritten or removed after being observed.

CREATE OR REPLACE FUNCTION reject_knowledge_audit_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'knowledge audit facts are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER knowledge_index_events_append_only
  BEFORE UPDATE OR DELETE ON knowledge_index_events
  FOR EACH ROW EXECUTE FUNCTION reject_knowledge_audit_fact_mutation();
CREATE TRIGGER knowledge_index_events_no_truncate
  BEFORE TRUNCATE ON knowledge_index_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_knowledge_audit_fact_mutation();
CREATE TRIGGER knowledge_deletion_proofs_append_only
  BEFORE UPDATE OR DELETE ON knowledge_deletion_proofs
  FOR EACH ROW EXECUTE FUNCTION reject_knowledge_audit_fact_mutation();
CREATE TRIGGER knowledge_deletion_proofs_no_truncate
  BEFORE TRUNCATE ON knowledge_deletion_proofs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_knowledge_audit_fact_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON knowledge_index_events FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON knowledge_deletion_proofs FROM PUBLIC;

DO $knowledge_audit_fact_role_security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE
      ON knowledge_index_events, knowledge_deletion_proofs FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON knowledge_index_events, knowledge_deletion_proofs FROM merchant_ops;
  END IF;
END
$knowledge_audit_fact_role_security$;
