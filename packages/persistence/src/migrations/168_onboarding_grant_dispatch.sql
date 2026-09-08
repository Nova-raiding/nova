-- 168_onboarding_grant_dispatch: append-only dispatch facts for scheduled
-- onboarding grants. The schedule is immutable; a dispatch row is the
-- idempotent link between one schedule row and one actual grant.

ALTER TABLE onboarding_point_grant_schedules_v2
  DROP CONSTRAINT IF EXISTS onboarding_point_grant_schedules_v2_activation_check;
ALTER TABLE onboarding_point_grant_schedules_v2
  ADD CONSTRAINT onboarding_point_grant_schedules_v2_activation_check
  CHECK (
    (status = 'blocked_policy_unresolved' AND due_at IS NULL AND expires_at IS NULL AND jsonb_array_length(blockers) > 0)
    OR
    (status IN ('scheduled', 'granted') AND due_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > due_at
      AND policy_ref IN ('commercial.onboarding.v1', 'commercial.onboarding.v2') AND blockers = '[]'::jsonb
      AND (status <> 'granted' OR grant_id IS NOT NULL))
    OR
    (status = 'canceled' AND due_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > due_at
      AND policy_ref IN ('commercial.onboarding.v1', 'commercial.onboarding.v2') AND blockers = '[]'::jsonb)
  );

CREATE TABLE onboarding_point_grant_dispatches_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL,
  onboarding_order_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 6),
  grant_id TEXT NOT NULL,
  points BIGINT NOT NULL CHECK (points = 500),
  policy_ref TEXT NOT NULL CHECK (policy_ref = 'commercial.onboarding.v2'),
  entitlement_snapshot_id TEXT NOT NULL,
  source_checksum TEXT NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  dispatched_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL,
  evidence JSONB NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, schedule_id),
  UNIQUE (workspace_id, grant_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, schedule_id) REFERENCES onboarding_point_grant_schedules_v2(workspace_id, id),
  FOREIGN KEY (workspace_id, grant_id) REFERENCES creative_point_grants(workspace_id, id),
  FOREIGN KEY (workspace_id, onboarding_order_id) REFERENCES commercial_orders_v2(workspace_id, id)
);

CREATE INDEX onboarding_grant_dispatch_due_evidence_idx
  ON onboarding_point_grant_dispatches_v2(workspace_id, dispatched_at, onboarding_order_id, sequence);

CREATE TABLE onboarding_point_grant_expirations_v2 (
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

ALTER TABLE onboarding_point_grant_dispatches_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_point_grant_dispatches_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_point_grant_dispatches_v2_workspace_isolation
  ON onboarding_point_grant_dispatches_v2
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE TRIGGER onboarding_point_grant_dispatches_v2_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON onboarding_point_grant_dispatches_v2
  FOR EACH STATEMENT EXECUTE FUNCTION reject_service_fulfillment_fact_mutation();
ALTER TABLE onboarding_point_grant_expirations_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_point_grant_expirations_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_point_grant_expirations_v2_workspace_isolation
  ON onboarding_point_grant_expirations_v2
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE TRIGGER onboarding_point_grant_expirations_v2_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON onboarding_point_grant_expirations_v2
  FOR EACH STATEMENT EXECUTE FUNCTION reject_service_fulfillment_fact_mutation();

DO $onboarding_dispatch_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON onboarding_point_grant_dispatches_v2, onboarding_point_grant_expirations_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON onboarding_point_grant_dispatches_v2, onboarding_point_grant_expirations_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON onboarding_point_grant_dispatches_v2, onboarding_point_grant_expirations_v2 TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON onboarding_point_grant_dispatches_v2, onboarding_point_grant_expirations_v2 FROM merchant_ops;
  END IF;
END
$onboarding_dispatch_acl$;
