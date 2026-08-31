-- Read-only, tenant-scoped projection over existing immutable audit facts.
CREATE INDEX IF NOT EXISTS workspace_operation_audit_page_idx
  ON workspace_operation_audit (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workspace_operation_audit_actor_page_idx
  ON workspace_operation_audit (workspace_id, actor_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workspace_operation_audit_action_page_idx
  ON workspace_operation_audit (workspace_id, action, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_workspace_operation_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workspace operation audit is append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS workspace_operation_audit_immutable ON workspace_operation_audit;
CREATE TRIGGER workspace_operation_audit_immutable
  BEFORE UPDATE OR DELETE ON workspace_operation_audit
  FOR EACH ROW EXECUTE FUNCTION reject_workspace_operation_audit_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON workspace_operation_audit FROM PUBLIC;

CREATE OR REPLACE VIEW ops_audit_center
WITH (security_barrier = true, security_invoker = true) AS
  SELECT 'operation'::text AS source, id::text, workspace_id, actor_id, action,
         resource_type, resource_id, reason, created_at AS occurred_at,
         jsonb_build_object('before', before_json, 'after', after_json) AS evidence
    FROM workspace_operation_audit
  UNION ALL
  SELECT 'rule', id, workspace_id, actor_id, 'rule.' || action,
         'rule_pack', rule_pack_id, COALESCE(reason, ''), occurred_at, data
    FROM rule_audit_events
  UNION ALL
  SELECT 'incident', id::text, workspace_id, actor_id, 'incident.' || kind,
         'incident', incident_id::text, body, created_at,
         jsonb_strip_nulls(jsonb_build_object('from_status', from_status, 'to_status', to_status, 'incident_revision', incident_revision))
    FROM ops_incident_timeline
  UNION ALL
  SELECT 'support', id::text, workspace_id, actor_id, 'support.' || event_type,
         'support_ticket', ticket_id::text, '', created_at, payload_json
    FROM workspace_support_ticket_events;

REVOKE ALL ON ops_audit_center FROM PUBLIC;
