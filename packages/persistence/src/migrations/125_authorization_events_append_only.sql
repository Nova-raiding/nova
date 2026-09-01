-- 125_authorization_events_append_only: database-owner-safe immutability for
-- authorization history. ACLs protect normal runtime roles, while these
-- triggers protect the audit trail from accidental UPDATE/DELETE paths.

CREATE OR REPLACE FUNCTION reject_authorization_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authorization events are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS platform_role_assignment_events_append_only
  ON platform_role_assignment_events;
CREATE TRIGGER platform_role_assignment_events_append_only
BEFORE UPDATE OR DELETE ON platform_role_assignment_events
FOR EACH ROW EXECUTE FUNCTION reject_authorization_event_mutation();

DROP TRIGGER IF EXISTS ops_access_grant_events_append_only
  ON ops_access_grant_events;
CREATE TRIGGER ops_access_grant_events_append_only
BEFORE UPDATE OR DELETE ON ops_access_grant_events
FOR EACH ROW EXECUTE FUNCTION reject_authorization_event_mutation();

REVOKE UPDATE, DELETE, TRUNCATE
  ON platform_role_assignment_events, ops_access_grant_events
FROM PUBLIC;
