-- Persistent platform identity, authenticated session, and risk lifecycle.
-- Raw credentials and provider session ids are never stored in these tables.

CREATE TABLE IF NOT EXISTS platform_identities (
  id UUID PRIMARY KEY,
  issuer TEXT NOT NULL CHECK (length(btrim(issuer)) BETWEEN 1 AND 512),
  external_subject TEXT NOT NULL CHECK (length(btrim(external_subject)) BETWEEN 1 AND 512),
  display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 512),
  access_status TEXT NOT NULL DEFAULT 'active' CHECK (access_status IN ('active', 'suspended')),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  risk_decision TEXT NOT NULL DEFAULT 'allow' CHECK (risk_decision IN ('allow', 'step_up', 'block')),
  auth_epoch BIGINT NOT NULL DEFAULT 1 CHECK (auth_epoch >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  suspended_at TIMESTAMPTZ,
  suspended_by TEXT,
  suspension_reason TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issuer, external_subject),
  CONSTRAINT platform_identities_suspension_check CHECK (
    (access_status = 'active' AND suspended_at IS NULL AND suspended_by IS NULL AND suspension_reason IS NULL)
    OR
    (access_status = 'suspended' AND suspended_at IS NOT NULL AND length(btrim(COALESCE(suspended_by, ''))) > 0 AND length(btrim(COALESCE(suspension_reason, ''))) > 0)
  )
);

CREATE INDEX IF NOT EXISTS platform_identities_governance_idx
  ON platform_identities (access_status, risk_decision, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS platform_auth_sessions (
  id UUID PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES platform_identities(id) ON DELETE RESTRICT,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('oidc', 'api_token')),
  provider_session_hash CHAR(64) NOT NULL CHECK (provider_session_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  auth_epoch BIGINT NOT NULL CHECK (auth_epoch >= 1),
  mfa_verified BOOLEAN NOT NULL DEFAULT false,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash CHAR(64) CHECK (ip_hash IS NULL OR ip_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash CHAR(64) CHECK (user_agent_hash IS NULL OR user_agent_hash ~ '^[a-f0-9]{64}$'),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  revoke_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (identity_id, provider_session_hash),
  CONSTRAINT platform_auth_sessions_expiry_check CHECK (expires_at IS NULL OR expires_at > issued_at),
  CONSTRAINT platform_auth_sessions_revocation_check CHECK (
    (status <> 'revoked' AND revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND length(btrim(COALESCE(revoked_by, ''))) > 0 AND length(btrim(COALESCE(revoke_reason, ''))) > 0)
  )
);

CREATE INDEX IF NOT EXISTS platform_auth_sessions_identity_status_idx
  ON platform_auth_sessions (identity_id, status, last_seen_at DESC, id);
CREATE INDEX IF NOT EXISTS platform_auth_sessions_expiry_idx
  ON platform_auth_sessions (expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_identity_events (
  id UUID PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES platform_identities(id) ON DELETE RESTRICT,
  session_id UUID REFERENCES platform_auth_sessions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (length(btrim(event_type)) BETWEEN 1 AND 128),
  actor_id TEXT NOT NULL CHECK (length(btrim(actor_id)) BETWEEN 1 AND 512),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  before_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id TEXT,
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_identity_events_idempotency_idx
  ON platform_identity_events (identity_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_identity_events_history_idx
  ON platform_identity_events (identity_id, created_at DESC, id DESC);

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS identity_id UUID REFERENCES platform_identities(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_identity_key
  ON workspace_members (workspace_id, identity_id) WHERE identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_members_identity_idx
  ON workspace_members (identity_id, status, workspace_id) WHERE identity_id IS NOT NULL;

ALTER TABLE platform_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_auth_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_identity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_identity_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_identities_scope ON platform_identities;
CREATE POLICY platform_identities_scope ON platform_identities
  USING (
    current_setting('app.platform_scope', true) = 'platform_ops'
    OR (issuer = current_setting('app.identity_issuer', true) AND external_subject = current_setting('app.identity_subject', true))
  )
  WITH CHECK (
    current_setting('app.platform_scope', true) = 'platform_ops'
    OR (issuer = current_setting('app.identity_issuer', true) AND external_subject = current_setting('app.identity_subject', true))
  );

DROP POLICY IF EXISTS platform_auth_sessions_scope ON platform_auth_sessions;
CREATE POLICY platform_auth_sessions_scope ON platform_auth_sessions
  USING (
    current_setting('app.platform_scope', true) = 'platform_ops'
    OR identity_id::text = current_setting('app.identity_id', true)
  )
  WITH CHECK (
    current_setting('app.platform_scope', true) = 'platform_ops'
    OR identity_id::text = current_setting('app.identity_id', true)
  );

DROP POLICY IF EXISTS platform_identity_events_scope ON platform_identity_events;
CREATE POLICY platform_identity_events_scope ON platform_identity_events
  USING (
    current_setting('app.platform_scope', true) = 'platform_ops'
    OR identity_id::text = current_setting('app.identity_id', true)
  )
  WITH CHECK (
    current_setting('app.platform_scope', true) = 'platform_ops'
    OR identity_id::text = current_setting('app.identity_id', true)
  );

-- Platform operations may enumerate member relationships, but writes remain
-- constrained to the transaction-local workspace scope.
DROP POLICY IF EXISTS workspace_members_isolation ON workspace_members;
DROP POLICY IF EXISTS workspace_members_select_scope ON workspace_members;
DROP POLICY IF EXISTS workspace_members_insert_scope ON workspace_members;
DROP POLICY IF EXISTS workspace_members_update_scope ON workspace_members;
DROP POLICY IF EXISTS workspace_members_delete_scope ON workspace_members;
CREATE POLICY workspace_members_select_scope ON workspace_members FOR SELECT
  USING (
    workspace_id = current_setting('app.workspace_id', true)
    OR current_setting('app.platform_scope', true) = 'platform_ops'
  );
CREATE POLICY workspace_members_insert_scope ON workspace_members FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_members_update_scope ON workspace_members FOR UPDATE
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_members_delete_scope ON workspace_members FOR DELETE
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_platform_identity_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform identity events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS platform_identity_events_append_only ON platform_identity_events;
CREATE TRIGGER platform_identity_events_append_only
  BEFORE UPDATE OR DELETE ON platform_identity_events
  FOR EACH ROW EXECUTE FUNCTION reject_platform_identity_event_mutation();
