-- 164_onboarding_grant_schedule_activation: activate only the resolved
-- onboarding schedule. Existing blocked rows remain immutable evidence.

ALTER TABLE onboarding_point_grant_schedules_v2
  DROP CONSTRAINT IF EXISTS onboarding_point_grant_schedules_v2_activation_check;

ALTER TABLE onboarding_point_grant_schedules_v2
  ADD CONSTRAINT onboarding_point_grant_schedules_v2_activation_check
  CHECK (
    (status = 'blocked_policy_unresolved'
      AND due_at IS NULL
      AND expires_at IS NULL
      AND jsonb_array_length(blockers) > 0)
    OR
    (status IN ('scheduled', 'granted')
      AND due_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > due_at
      AND policy_ref = 'commercial.onboarding.v1'
      AND blockers = '[]'::jsonb
      AND (status <> 'granted' OR grant_id IS NOT NULL))
    OR
    (status = 'canceled'
      AND due_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > due_at
      AND policy_ref = 'commercial.onboarding.v1'
      AND blockers = '[]'::jsonb)
  );

CREATE INDEX IF NOT EXISTS onboarding_grant_schedule_due_idx
  ON onboarding_point_grant_schedules_v2(workspace_id, status, due_at, expires_at, id);

-- Payment persistence inserts all six rows atomically; no role may mutate a
-- row later to bypass the grant audit.
REVOKE UPDATE, DELETE, TRUNCATE ON onboarding_point_grant_schedules_v2 FROM PUBLIC;
DO $onboarding_schedule_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON onboarding_point_grant_schedules_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON onboarding_point_grant_schedules_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON onboarding_point_grant_schedules_v2 FROM merchant_ops;
  END IF;
END
$onboarding_schedule_acl$;
