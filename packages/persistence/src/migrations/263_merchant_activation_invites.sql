-- Safe operator provisioning: customer chooses a password using a one-use
-- activation intent. This activation is not a paid commercial qualification.
CREATE TABLE platform_merchant_activation_invites (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES platform_password_accounts(id) ON DELETE RESTRICT,
  reset_token_id uuid NOT NULL UNIQUE REFERENCES platform_password_reset_tokens(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  intent_hash char(64) NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, idempotency_key)
);
CREATE INDEX platform_merchant_activation_invites_account_idx ON platform_merchant_activation_invites(account_id,created_at,id);
ALTER TABLE platform_merchant_activation_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_merchant_activation_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_merchant_activation_invites_ops ON platform_merchant_activation_invites
  USING (current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_setting('app.platform_scope', true) = 'platform_ops');
GRANT SELECT, INSERT ON platform_merchant_activation_invites TO merchant_ops;
REVOKE UPDATE, DELETE, TRUNCATE ON platform_merchant_activation_invites FROM merchant_ops;
-- An invited account has not accepted the customer terms. Acceptance is
-- recorded by the same transaction that consumes its activation token.
ALTER TABLE platform_password_accounts DROP CONSTRAINT platform_password_account_terms;
ALTER TABLE platform_password_accounts ADD CONSTRAINT platform_password_account_terms
  CHECK (account_type <> 'merchant' OR terms_agreed_at IS NOT NULL OR status = 'merchant_pending');

REVOKE ALL ON platform_merchant_activation_invites FROM PUBLIC, merchant_app;
GRANT SELECT, INSERT ON workspaces, workspace_identity_bindings, workspace_operation_audit TO merchant_ops;
GRANT SELECT, INSERT, UPDATE ON workspace_members TO merchant_ops;
