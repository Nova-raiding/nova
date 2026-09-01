-- 147_platform_authorization_audit: append-only audit sink for platform scope.
-- This is deliberately separate from tenant-scoped workspace_operation_audit.

CREATE TABLE IF NOT EXISTS platform_authorization_audit (
  id UUID PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  policy_version TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  workbench TEXT NOT NULL CHECK (workbench = 'platform'),
  capability TEXT NOT NULL,
  method TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('allow', 'deny')),
  reason_code TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_scope JSONB NOT NULL CHECK (jsonb_typeof(resource_scope) = 'object'),
  request_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object' AND pg_column_size(evidence) <= 32768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_authorization_audit_created_idx ON platform_authorization_audit (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS platform_authorization_audit_actor_idx ON platform_authorization_audit (actor_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS platform_authorization_audit_method_idx ON platform_authorization_audit (method, result, created_at DESC, id DESC);

ALTER TABLE platform_authorization_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_authorization_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_authorization_audit_ops_scope ON platform_authorization_audit;
CREATE POLICY platform_authorization_audit_ops_scope ON platform_authorization_audit
  USING (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops');

CREATE OR REPLACE FUNCTION reject_platform_authorization_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform authorization audit is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS platform_authorization_audit_immutable ON platform_authorization_audit;
CREATE TRIGGER platform_authorization_audit_immutable
  BEFORE UPDATE OR DELETE ON platform_authorization_audit
  FOR EACH ROW EXECUTE FUNCTION reject_platform_authorization_audit_mutation();
DROP TRIGGER IF EXISTS platform_authorization_audit_no_truncate ON platform_authorization_audit;
CREATE TRIGGER platform_authorization_audit_no_truncate
  BEFORE TRUNCATE ON platform_authorization_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_authorization_audit_mutation();

REVOKE ALL ON platform_authorization_audit FROM PUBLIC;
REVOKE ALL ON platform_authorization_audit FROM merchant_app;
GRANT SELECT, INSERT ON platform_authorization_audit TO merchant_ops;
REVOKE UPDATE, DELETE, TRUNCATE ON platform_authorization_audit FROM merchant_ops;
