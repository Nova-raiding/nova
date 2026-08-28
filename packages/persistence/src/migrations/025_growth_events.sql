CREATE TABLE IF NOT EXISTS workspace_growth_events (
  id text PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL, source_channel text, actor_id text, plan_code text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_growth_events_funnel_idx ON workspace_growth_events(workspace_id, source_channel, occurred_at, event_type);
ALTER TABLE workspace_growth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_growth_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_growth_events_workspace_isolation ON workspace_growth_events;
CREATE POLICY workspace_growth_events_workspace_isolation ON workspace_growth_events USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
