-- 135_authorization_event_scope_integrity: authorization history must carry
-- the same subject/workspace scope as the grant or role assignment it records.
-- Foreign keys prove existence only; these triggers close the remaining
-- database-owner and privileged-writer path for forged audit context.

CREATE OR REPLACE FUNCTION validate_platform_role_assignment_event_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_subject UUID;
BEGIN
  SELECT subject_identity_id INTO expected_subject
    FROM platform_role_assignments
   WHERE id = NEW.assignment_id;
  IF expected_subject IS NULL OR expected_subject IS DISTINCT FROM NEW.subject_identity_id THEN
    RAISE EXCEPTION 'platform role assignment event scope is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_role_assignment_events_scope_integrity
  ON platform_role_assignment_events;
CREATE TRIGGER platform_role_assignment_events_scope_integrity
BEFORE INSERT ON platform_role_assignment_events
FOR EACH ROW EXECUTE FUNCTION validate_platform_role_assignment_event_scope();

CREATE OR REPLACE FUNCTION validate_ops_access_grant_event_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_subject UUID;
  expected_workspace TEXT;
BEGIN
  SELECT subject_identity_id, workspace_id
    INTO expected_subject, expected_workspace
    FROM ops_access_grants
   WHERE id = NEW.grant_id;
  IF expected_subject IS NULL
     OR expected_subject IS DISTINCT FROM NEW.subject_identity_id
     OR expected_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'ops access grant event scope is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ops_access_grant_events_scope_integrity
  ON ops_access_grant_events;
CREATE TRIGGER ops_access_grant_events_scope_integrity
BEFORE INSERT ON ops_access_grant_events
FOR EACH ROW EXECUTE FUNCTION validate_ops_access_grant_event_scope();
