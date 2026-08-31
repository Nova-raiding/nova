CREATE TABLE IF NOT EXISTS ops_incidents (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 3 AND 4000),
  severity TEXT NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status TEXT NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  commander_id TEXT,
  affected_components TEXT[] NOT NULL DEFAULT '{}',
  affected_workspace_ids TEXT[] NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (workspace_id, id),
  CHECK (cardinality(affected_components) <= 100),
  CHECK (cardinality(affected_workspace_ids) <= 500),
  CHECK ((status = 'resolved' AND resolved_at IS NOT NULL) OR (status <> 'resolved' AND resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS ops_incidents_workspace_page_idx
  ON ops_incidents(workspace_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ops_incidents_workspace_status_page_idx
  ON ops_incidents(workspace_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ops_incidents_workspace_severity_page_idx
  ON ops_incidents(workspace_id, severity, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ops_incident_timeline (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  incident_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'comment', 'status_changed', 'commander_changed', 'scope_changed')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  to_status TEXT CHECK (to_status IS NULL OR to_status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  actor_id TEXT NOT NULL,
  incident_revision INTEGER NOT NULL CHECK (incident_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, incident_id) REFERENCES ops_incidents(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ops_incident_timeline_page_idx
  ON ops_incident_timeline(workspace_id, incident_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS ops_incident_idempotency (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ops_incident_idempotency_expiry_idx
  ON ops_incident_idempotency(created_at);

ALTER TABLE ops_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_incidents_isolation ON ops_incidents
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE ops_incident_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_incident_timeline FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_incident_timeline_isolation ON ops_incident_timeline
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE ops_incident_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_incident_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY ops_incident_idempotency_isolation ON ops_incident_idempotency
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_ops_incident_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ops incident history is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ops_incident_timeline_immutable ON ops_incident_timeline;
CREATE TRIGGER ops_incident_timeline_immutable
  BEFORE UPDATE OR DELETE ON ops_incident_timeline
  FOR EACH ROW EXECUTE FUNCTION reject_ops_incident_history_mutation();

DROP TRIGGER IF EXISTS ops_incident_idempotency_immutable ON ops_incident_idempotency;
CREATE TRIGGER ops_incident_idempotency_immutable
  BEFORE UPDATE OR DELETE ON ops_incident_idempotency
  FOR EACH ROW EXECUTE FUNCTION reject_ops_incident_history_mutation();
