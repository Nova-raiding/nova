-- 134_authorization_events_truncate_guard: close the owner-level mutation path
-- left by migration 125. Authorization history is append-only even when a
-- database owner or migration session can bypass ordinary table privileges.

CREATE OR REPLACE FUNCTION reject_authorization_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authorization events are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS platform_role_assignment_events_no_truncate
  ON platform_role_assignment_events;
CREATE TRIGGER platform_role_assignment_events_no_truncate
BEFORE TRUNCATE ON platform_role_assignment_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_authorization_event_mutation();

DROP TRIGGER IF EXISTS ops_access_grant_events_no_truncate
  ON ops_access_grant_events;
CREATE TRIGGER ops_access_grant_events_no_truncate
BEFORE TRUNCATE ON ops_access_grant_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_authorization_event_mutation();
