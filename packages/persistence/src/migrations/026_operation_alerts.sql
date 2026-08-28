CREATE TABLE IF NOT EXISTS workspace_operation_alerts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  alert_key TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high','medium')),
  platform TEXT,
  account_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged')),
  observed_at TIMESTAMPTZ NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_action TEXT NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  acknowledgement_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, alert_key)
);
CREATE INDEX IF NOT EXISTS workspace_operation_alerts_status_idx ON workspace_operation_alerts(workspace_id, status, updated_at DESC);
ALTER TABLE workspace_operation_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_operation_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_operation_alerts_isolation ON workspace_operation_alerts USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
