CREATE TABLE local_plugin_install_instances (
  id uuid PRIMARY KEY,
  account_id uuid REFERENCES platform_password_accounts(id) ON DELETE RESTRICT,
  identity_id uuid REFERENCES platform_identities(id) ON DELETE RESTRICT,
  workspace_id text REFERENCES workspaces(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('macos','windows')),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]+$'),
  public_key_fingerprint text NOT NULL CHECK (public_key_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  pairing_token_hash text CHECK (pairing_token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  pairing_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id,workspace_id,public_key_fingerprint),
  CHECK ((account_id IS NULL AND identity_id IS NULL AND workspace_id IS NULL AND pairing_token_hash IS NOT NULL AND pairing_expires_at IS NOT NULL) OR (account_id IS NOT NULL AND identity_id IS NOT NULL AND workspace_id IS NOT NULL AND pairing_token_hash IS NULL AND pairing_expires_at IS NULL))
);
CREATE TABLE local_plugin_install_challenges (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES local_plugin_install_instances(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL REFERENCES local_plugin_connection_requests(id) ON DELETE RESTRICT,
  challenge_hash text NOT NULL CHECK (challenge_hash ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at), CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE UNIQUE INDEX local_plugin_install_challenges_active_idx ON local_plugin_install_challenges(instance_id,request_id) WHERE consumed_at IS NULL;
CREATE INDEX local_plugin_install_instances_owner_idx ON local_plugin_install_instances(account_id,identity_id,workspace_id);
CREATE TABLE local_plugin_install_audit (
  id uuid PRIMARY KEY, instance_id uuid NOT NULL REFERENCES local_plugin_install_instances(id) ON DELETE RESTRICT,
  event_type text NOT NULL, account_id uuid, identity_id uuid, workspace_id text, request_id uuid,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE local_plugin_install_instances ENABLE ROW LEVEL SECURITY; ALTER TABLE local_plugin_install_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE local_plugin_install_challenges ENABLE ROW LEVEL SECURITY; ALTER TABLE local_plugin_install_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE local_plugin_install_audit ENABLE ROW LEVEL SECURITY; ALTER TABLE local_plugin_install_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY local_plugin_install_instances_ops ON local_plugin_install_instances USING (current_setting('app.platform_scope',true)='platform_ops') WITH CHECK (current_setting('app.platform_scope',true)='platform_ops');
CREATE POLICY local_plugin_install_challenges_ops ON local_plugin_install_challenges USING (current_setting('app.platform_scope',true)='platform_ops') WITH CHECK (current_setting('app.platform_scope',true)='platform_ops');
CREATE POLICY local_plugin_install_audit_ops ON local_plugin_install_audit USING (current_setting('app.platform_scope',true)='platform_ops') WITH CHECK (current_setting('app.platform_scope',true)='platform_ops');
CREATE FUNCTION reject_local_plugin_install_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local plugin install audit is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER local_plugin_install_audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON local_plugin_install_audit FOR EACH STATEMENT EXECUTE FUNCTION reject_local_plugin_install_audit_mutation();
REVOKE ALL ON local_plugin_install_instances, local_plugin_install_challenges, local_plugin_install_audit FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
  GRANT SELECT,INSERT,UPDATE ON local_plugin_install_instances, local_plugin_install_challenges TO merchant_ops;
  GRANT SELECT,INSERT ON local_plugin_install_audit TO merchant_ops;
  REVOKE DELETE,TRUNCATE ON local_plugin_install_instances, local_plugin_install_challenges FROM merchant_ops;
END IF; END $$;
