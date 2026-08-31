CREATE TABLE IF NOT EXISTS workspace_operation_alert_notifications (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  alert_id TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('disabled','blocked','delivered','failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0 AND attempts <= 3),
  request_id TEXT,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, alert_id)
);
CREATE INDEX IF NOT EXISTS workspace_operation_alert_notifications_delivery_idx ON workspace_operation_alert_notifications(workspace_id, delivery, updated_at DESC);
ALTER TABLE workspace_operation_alert_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_operation_alert_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_operation_alert_notifications_isolation ON workspace_operation_alert_notifications USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
