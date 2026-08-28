CREATE TABLE IF NOT EXISTS workspace_operation_audit (
  id UUID PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
  before_json JSONB NOT NULL DEFAULT '{}'::jsonb, after_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_operation_audit_workspace_idx ON workspace_operation_audit(workspace_id, created_at DESC);
ALTER TABLE workspace_operation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_operation_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_operation_audit_isolation ON workspace_operation_audit USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
