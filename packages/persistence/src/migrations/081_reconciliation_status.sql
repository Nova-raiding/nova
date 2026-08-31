-- 081_reconciliation_status: latest workspace-scoped reconciliation state.
-- The row is a projection; source evidence remains in the owning domain tables.

CREATE TABLE IF NOT EXISTS workspace_reconciliation_status (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (length(btrim(resource_type)) BETWEEN 1 AND 128),
  resource_id text NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 256),
  status text NOT NULL CHECK (status IN ('pending','running','succeeded','failed','manual_attention')),
  last_idempotency_key text NOT NULL CHECK (length(btrim(last_idempotency_key)) BETWEEN 1 AND 512),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  observed_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS workspace_reconciliation_status_recent_idx
  ON workspace_reconciliation_status (workspace_id, updated_at DESC, resource_type, resource_id);

ALTER TABLE workspace_reconciliation_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_reconciliation_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_reconciliation_status_workspace_isolation ON workspace_reconciliation_status;
CREATE POLICY workspace_reconciliation_status_workspace_isolation ON workspace_reconciliation_status
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE workspace_reconciliation_status FROM merchant_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE workspace_reconciliation_status TO merchant_app;
  END IF;
END
$$;
