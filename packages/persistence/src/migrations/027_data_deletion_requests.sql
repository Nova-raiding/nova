CREATE TABLE IF NOT EXISTS workspace_data_deletion_requests (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('workspace','assets','business')),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  grace_period_days INTEGER NOT NULL CHECK (grace_period_days BETWEEN 7 AND 30),
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','completed','incomplete')),
  idempotency_key TEXT NOT NULL,
  cancelled_by TEXT,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS workspace_data_deletion_requests_status_idx ON workspace_data_deletion_requests(workspace_id, status, scheduled_for);
ALTER TABLE workspace_data_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_data_deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_data_deletion_requests_isolation ON workspace_data_deletion_requests USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
