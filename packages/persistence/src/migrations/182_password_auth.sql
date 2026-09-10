-- Password identity credentials and opaque browser sessions. Raw passwords and
-- raw session/reset tokens are never persisted.
CREATE TABLE IF NOT EXISTS platform_password_accounts (
  id UUID PRIMARY KEY,
  identity_id UUID NOT NULL UNIQUE REFERENCES platform_identities(id) ON DELETE RESTRICT,
  login_identifier TEXT NOT NULL UNIQUE CHECK (length(btrim(login_identifier)) BETWEEN 3 AND 128),
  account_type TEXT NOT NULL CHECK (account_type IN ('merchant', 'platform')),
  enterprise_name TEXT,
  contact_name TEXT,
  password_hash TEXT NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  terms_agreed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'merchant_pending' CHECK (status IN ('merchant_pending', 'active', 'suspended', 'revoked')),
  roles TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  workspace_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  auth_epoch BIGINT NOT NULL DEFAULT 1 CHECK (auth_epoch >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_password_account_terms CHECK (account_type <> 'merchant' OR terms_agreed_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS platform_password_sessions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES platform_password_accounts(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  auth_epoch BIGINT NOT NULL CHECK (auth_epoch >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  ip_hash CHAR(64),
  user_agent_hash CHAR(64),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_password_reset_tokens (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES platform_password_accounts(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_password_sessions_account_idx ON platform_password_sessions(account_id, status, expires_at);
CREATE INDEX IF NOT EXISTS platform_password_reset_tokens_expiry_idx ON platform_password_reset_tokens(expires_at) WHERE used_at IS NULL;
ALTER TABLE platform_password_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_password_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_password_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_password_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_password_reset_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_password_accounts_ops ON platform_password_accounts;
CREATE POLICY platform_password_accounts_ops ON platform_password_accounts USING (current_setting('app.platform_scope', true) = 'platform_ops') WITH CHECK (current_setting('app.platform_scope', true) = 'platform_ops');
DROP POLICY IF EXISTS platform_password_sessions_ops ON platform_password_sessions;
CREATE POLICY platform_password_sessions_ops ON platform_password_sessions USING (current_setting('app.platform_scope', true) = 'platform_ops') WITH CHECK (current_setting('app.platform_scope', true) = 'platform_ops');
DROP POLICY IF EXISTS platform_password_reset_tokens_ops ON platform_password_reset_tokens;
CREATE POLICY platform_password_reset_tokens_ops ON platform_password_reset_tokens USING (current_setting('app.platform_scope', true) = 'platform_ops') WITH CHECK (current_setting('app.platform_scope', true) = 'platform_ops');
GRANT SELECT, INSERT, UPDATE ON platform_password_accounts, platform_password_sessions, platform_password_reset_tokens TO merchant_ops;
REVOKE DELETE, TRUNCATE ON platform_password_accounts, platform_password_sessions, platform_password_reset_tokens FROM merchant_ops;
