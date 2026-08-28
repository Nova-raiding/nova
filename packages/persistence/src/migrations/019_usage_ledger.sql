ALTER TABLE workspace_commercial_settings ADD COLUMN IF NOT EXISTS usage_period_start DATE NOT NULL DEFAULT date_trunc('month', now())::date;
ALTER TABLE workspace_commercial_settings ADD COLUMN IF NOT EXISTS monthly_tasks_used INTEGER NOT NULL DEFAULT 0 CHECK (monthly_tasks_used >= 0);
CREATE TABLE IF NOT EXISTS workspace_usage_ledger (
  id UUID PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, units INTEGER NOT NULL DEFAULT 1,
  refunded BOOLEAN NOT NULL DEFAULT false, refund_reason TEXT, actor_id TEXT NOT NULL,
  refunded_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), refunded_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS workspace_usage_ledger_workspace_idx ON workspace_usage_ledger(workspace_id, created_at DESC);
ALTER TABLE workspace_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_usage_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_usage_ledger_isolation ON workspace_usage_ledger USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
