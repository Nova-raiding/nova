-- First-party MCP OAuth credentials bound to the canonical password identity.
-- Authorization codes and tokens are opaque; only SHA-256 digests are stored.
-- These redundant-looking unique constraints are FK targets: they make the
-- account/identity and workspace/identity relationships indivisible at the
-- database boundary instead of trusting callers to join independent IDs.
ALTER TABLE platform_password_accounts
  ADD CONSTRAINT platform_password_accounts_id_identity_key UNIQUE (id, identity_id);
ALTER TABLE workspace_members
  ADD CONSTRAINT workspace_members_workspace_identity_unique UNIQUE (workspace_id, identity_id);

CREATE TABLE mcp_oauth_authorization_codes (
  id UUID PRIMARY KEY,
  code_hash CHAR(64) NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  client_id TEXT NOT NULL CHECK (length(btrim(client_id)) BETWEEN 1 AND 256),
  redirect_uri TEXT NOT NULL CHECK (length(btrim(redirect_uri)) BETWEEN 1 AND 2048),
  account_id UUID NOT NULL,
  identity_id UUID NOT NULL REFERENCES platform_identities(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope TEXT[] NOT NULL CHECK (cardinality(scope) > 0),
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  resource TEXT NOT NULL,
  account_auth_epoch BIGINT NOT NULL CHECK (account_auth_epoch >= 1),
  identity_auth_epoch BIGINT NOT NULL CHECK (identity_auth_epoch >= 1),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  FOREIGN KEY (account_id, identity_id)
    REFERENCES platform_password_accounts(id, identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, identity_id)
    REFERENCES workspace_members(workspace_id, identity_id) ON DELETE RESTRICT
);

CREATE TABLE mcp_oauth_tokens (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL,
  token_kind TEXT NOT NULL CHECK (token_kind IN ('access', 'refresh')),
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  client_id TEXT NOT NULL CHECK (length(btrim(client_id)) BETWEEN 1 AND 256),
  account_id UUID NOT NULL,
  identity_id UUID NOT NULL REFERENCES platform_identities(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  scope TEXT[] NOT NULL CHECK (cardinality(scope) > 0),
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  resource TEXT NOT NULL,
  account_auth_epoch BIGINT NOT NULL CHECK (account_auth_epoch >= 1),
  identity_auth_epoch BIGINT NOT NULL CHECK (identity_auth_epoch >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked', 'expired')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  rotated_to_id UUID REFERENCES mcp_oauth_tokens(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR status <> 'active'),
  FOREIGN KEY (account_id, identity_id)
    REFERENCES platform_password_accounts(id, identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, identity_id)
    REFERENCES workspace_members(workspace_id, identity_id) ON DELETE RESTRICT
);

CREATE INDEX mcp_oauth_authorization_codes_expiry_idx
  ON mcp_oauth_authorization_codes (expires_at) WHERE used_at IS NULL;
CREATE INDEX mcp_oauth_tokens_family_idx
  ON mcp_oauth_tokens (family_id, status, token_kind, expires_at);
CREATE INDEX mcp_oauth_tokens_identity_idx
  ON mcp_oauth_tokens (identity_id, workspace_id, status, expires_at);

ALTER TABLE mcp_oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_authorization_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY mcp_oauth_authorization_codes_ops ON mcp_oauth_authorization_codes
  USING (current_user = 'merchant_ops'
    AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops'
    AND current_setting('app.platform_scope', true) = 'platform_ops');
CREATE POLICY mcp_oauth_tokens_ops ON mcp_oauth_tokens
  USING (current_user = 'merchant_ops'
    AND current_setting('app.platform_scope', true) = 'platform_ops')
  WITH CHECK (current_user = 'merchant_ops'
    AND current_setting('app.platform_scope', true) = 'platform_ops');

REVOKE ALL ON mcp_oauth_authorization_codes, mcp_oauth_tokens FROM PUBLIC, merchant_app;
GRANT SELECT, INSERT, UPDATE ON mcp_oauth_authorization_codes, mcp_oauth_tokens TO merchant_ops;
GRANT SELECT ON workspaces, workspace_members TO merchant_ops;
GRANT UPDATE (identity_id, revision, updated_at) ON workspace_members TO merchant_ops;
REVOKE DELETE, TRUNCATE ON mcp_oauth_authorization_codes, mcp_oauth_tokens FROM merchant_ops;
