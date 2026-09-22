CREATE TABLE local_plugin_connection_requests (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES platform_password_accounts(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL REFERENCES platform_identities(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','exchanged','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  authorized_at timestamptz,
  exchanged_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((status = 'pending' AND authorized_at IS NULL AND exchanged_at IS NULL) OR (status IN ('authorized','expired') AND exchanged_at IS NULL) OR (status = 'exchanged' AND authorized_at IS NOT NULL AND exchanged_at IS NOT NULL))
);
CREATE INDEX local_plugin_connection_requests_owner_idx ON local_plugin_connection_requests(account_id,workspace_id,created_at DESC);
CREATE UNIQUE INDEX local_plugin_connection_requests_one_active_idx ON local_plugin_connection_requests(account_id,workspace_id) WHERE status IN ('pending','authorized');
ALTER TABLE local_plugin_connection_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_plugin_connection_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY local_plugin_connection_requests_ops ON local_plugin_connection_requests
  USING (current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_setting('app.platform_scope', true) = 'platform_ops');
REVOKE ALL ON local_plugin_connection_requests FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
    GRANT SELECT,INSERT,UPDATE ON local_plugin_connection_requests TO merchant_ops;
    REVOKE DELETE,TRUNCATE ON local_plugin_connection_requests FROM merchant_ops;
  END IF;
END $$;
