-- 157_service_fulfillment_audit_evidence: forward-only audit strengthening
-- for service allocations and unresolved onboarding grant schedules. Migration
-- 154 is already deployed and remains byte-for-byte immutable.

ALTER TABLE onboarding_point_grant_schedules_v2
  ADD COLUMN created_by_actor_id TEXT,
  ADD COLUMN creation_reason TEXT,
  ADD COLUMN creation_evidence JSONB;

-- Existing schedule rows predate this evidence contract. They stay explicitly
-- incomplete and cannot be mutated into fake evidence. Every new row must
-- carry actor, reason and non-empty evidence.
CREATE OR REPLACE FUNCTION require_onboarding_schedule_creation_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by_actor_id IS NULL OR length(trim(NEW.created_by_actor_id)) = 0
     OR NEW.creation_reason IS NULL OR length(trim(NEW.creation_reason)) = 0
     OR NEW.creation_evidence IS NULL OR NEW.creation_evidence = '{}'::jsonb THEN
    RAISE EXCEPTION 'onboarding schedule creation evidence is required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER onboarding_point_grant_schedules_v2_require_creation_evidence
BEFORE INSERT ON onboarding_point_grant_schedules_v2
FOR EACH ROW EXECUTE FUNCTION require_onboarding_schedule_creation_evidence();
