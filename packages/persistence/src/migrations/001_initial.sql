-- 001_initial: PostgreSQL baseline for the merchant marketing service.
-- Apply through MigrationRunner; do not run this file outside a transaction.

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  capacity_tier text NOT NULL DEFAULT 'pilot_50',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_accounts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  platform text NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  remote_account_id text NOT NULL,
  credential_ref text NOT NULL,
  token_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, remote_account_id)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  sequence integer NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  last_error jsonb,
  unknown_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, aggregate_id, event_type, sequence)
);

ALTER TABLE platform_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
-- The runtime role must not bypass tenant policy merely because a deployment
-- accidentally grants it table ownership. Superusers remain outside the
-- database policy boundary and must never be used by the application.
ALTER TABLE platform_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_accounts_workspace_isolation ON platform_accounts;
CREATE POLICY platform_accounts_workspace_isolation ON platform_accounts
  USING (workspace_id = current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS outbox_events_workspace_isolation ON outbox_events;
CREATE POLICY outbox_events_workspace_isolation ON outbox_events
  USING (workspace_id = current_setting('app.workspace_id', true));
