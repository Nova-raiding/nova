-- 169_onboarding_grant_expiration: forward-only repair for databases where
-- migration 168 was already applied before expiration evidence was added.

CREATE TABLE IF NOT EXISTS onboarding_point_grant_expirations_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL,
  onboarding_order_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 6),
  points BIGINT NOT NULL CHECK (points = 500),
  policy_ref TEXT NOT NULL CHECK (policy_ref = 'commercial.onboarding.v2'),
  entitlement_snapshot_id TEXT NOT NULL,
  source_checksum TEXT NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  expired_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, schedule_id),
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES onboarding_point_grant_schedules_v2(workspace_id, id),
  FOREIGN KEY (workspace_id, onboarding_order_id) REFERENCES commercial_orders_v2(workspace_id, id)
);

ALTER TABLE onboarding_point_grant_expirations_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_point_grant_expirations_v2 FORCE ROW LEVEL SECURITY;
DO $expiration_policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='onboarding_point_grant_expirations_v2' AND policyname='onboarding_point_grant_expirations_v2_workspace_isolation') THEN
    CREATE POLICY onboarding_point_grant_expirations_v2_workspace_isolation ON onboarding_point_grant_expirations_v2
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='onboarding_point_grant_expirations_v2_append_only') THEN
    CREATE TRIGGER onboarding_point_grant_expirations_v2_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON onboarding_point_grant_expirations_v2
      FOR EACH STATEMENT EXECUTE FUNCTION reject_service_fulfillment_fact_mutation();
  END IF;
END
$expiration_policy$;

DO $expiration_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON onboarding_point_grant_expirations_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON onboarding_point_grant_expirations_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON onboarding_point_grant_expirations_v2 TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON onboarding_point_grant_expirations_v2 FROM merchant_ops;
  END IF;
END
$expiration_acl$;
