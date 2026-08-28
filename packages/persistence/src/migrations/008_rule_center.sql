-- 008_rule_center: durable, tenant-scoped immutable rule versions and audit.
-- Rule details are stored as a JSON object so the review package can evolve
-- its deterministic checks without requiring a schema migration per field.

CREATE TABLE IF NOT EXISTS rule_pack_versions (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  pack_id text NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global', 'platform', 'category', 'brand', 'store', 'campaign')),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'inactive', 'expired')),
  source_kind text NOT NULL CHECK (source_kind IN ('official', 'internal', 'legal_review')),
  source_reference text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  checks jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checks) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  activated_at timestamptz,
  deactivated_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, pack_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS rule_pack_versions_one_active_idx
  ON rule_pack_versions (workspace_id, pack_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS rule_pack_versions_workspace_status_idx
  ON rule_pack_versions (workspace_id, status, updated_at DESC, pack_id, version);

CREATE INDEX IF NOT EXISTS rule_pack_versions_workspace_pack_idx
  ON rule_pack_versions (workspace_id, pack_id, created_at DESC, version);

CREATE TABLE IF NOT EXISTS rule_audit_events (
  id text NOT NULL,
  workspace_id text NOT NULL,
  rule_pack_id text NOT NULL,
  rule_version_id text NOT NULL,
  version text NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'activated', 'deactivated', 'expired')),
  actor_id text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT rule_audit_events_version_fk
    FOREIGN KEY (workspace_id, rule_version_id)
    REFERENCES rule_pack_versions (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS rule_audit_events_workspace_pack_idx
  ON rule_audit_events (workspace_id, rule_pack_id, occurred_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS rule_audit_events_workspace_version_idx
  ON rule_audit_events (workspace_id, rule_version_id, occurred_at ASC, id ASC);

ALTER TABLE rule_pack_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_pack_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rule_pack_versions_workspace_isolation ON rule_pack_versions;
CREATE POLICY rule_pack_versions_workspace_isolation ON rule_pack_versions
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE rule_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rule_audit_events_workspace_isolation ON rule_audit_events;
CREATE POLICY rule_audit_events_workspace_isolation ON rule_audit_events
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Audit history is append-only at the database boundary. Administrative
-- corrections must be represented by a new event, never by rewriting history.
CREATE OR REPLACE FUNCTION reject_rule_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rule audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS rule_audit_events_append_only ON rule_audit_events;
CREATE TRIGGER rule_audit_events_append_only
  BEFORE UPDATE OR DELETE ON rule_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_rule_audit_mutation();
