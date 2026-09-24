-- A first-install demo evaluation is a distinct grant. It never asserts a
-- payment, commercial order, subscription period, or paid V2 entitlement.
CREATE TABLE demo_evaluation_entitlements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT demo_evaluation_only_first_workspace CHECK (workspace_id = 'ws_guirenniaoniao'),
  CONSTRAINT demo_evaluation_valid_window CHECK (expires_at > starts_at),
  CONSTRAINT demo_evaluation_reason_not_blank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT demo_evaluation_actor_not_blank CHECK (length(btrim(actor_id)) > 0)
);

CREATE UNIQUE INDEX demo_evaluation_one_active_grant
  ON demo_evaluation_entitlements(workspace_id) WHERE status = 'active';

ALTER TABLE demo_evaluation_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_evaluation_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_evaluation_workspace_read ON demo_evaluation_entitlements
  FOR SELECT USING (workspace_id = current_setting('app.workspace_id', true));

-- Runtime may read the scoped projection, never manufacture an evaluation grant.
DO $demo_evaluation_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT ON demo_evaluation_entitlements TO merchant_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON demo_evaluation_entitlements FROM merchant_app;
  END IF;
END
$demo_evaluation_acl$;

CREATE OR REPLACE FUNCTION reject_demo_evaluation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'demo evaluation grant is immutable';
END;
$$;
CREATE TRIGGER demo_evaluation_append_only
  BEFORE UPDATE OR DELETE ON demo_evaluation_entitlements
  FOR EACH ROW EXECUTE FUNCTION reject_demo_evaluation_mutation();
