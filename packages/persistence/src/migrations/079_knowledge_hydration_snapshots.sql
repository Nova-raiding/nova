-- 079_knowledge_hydration_snapshots: durable workspace-scoped knowledge
-- projection and ordered event cursor. The outbox remains the source of truth.

CREATE TABLE IF NOT EXISTS knowledge_hydration_snapshots (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id text NOT NULL,
  cursor_created_at timestamptz NOT NULL,
  cursor_event_id text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(events) = 'array')
);

CREATE INDEX IF NOT EXISTS knowledge_hydration_snapshots_cursor_idx
  ON knowledge_hydration_snapshots (workspace_id, cursor_created_at, cursor_event_id);

ALTER TABLE knowledge_hydration_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_hydration_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_hydration_snapshots_workspace_isolation ON knowledge_hydration_snapshots;
CREATE POLICY knowledge_hydration_snapshots_workspace_isolation ON knowledge_hydration_snapshots
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE knowledge_hydration_snapshots FROM merchant_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE knowledge_hydration_snapshots TO merchant_app;
  END IF;
END
$$;
