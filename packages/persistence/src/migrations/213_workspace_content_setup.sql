CREATE TABLE IF NOT EXISTS workspace_content_setup (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  platform text NOT NULL,
  account_id text NOT NULL,
  actor_id text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspace_content_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_content_setup FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_content_setup_isolation ON workspace_content_setup
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE workspace_content_setup TO merchant_app;
    GRANT INSERT ON TABLE workspace_operation_audit TO merchant_app;
  END IF;
END $$;
