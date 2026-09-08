-- 173_private_trial_invite_events: append-only redemption facts for private
-- trial invites. This is deliberately separate from 172 so applied migration
-- checksums remain immutable.

CREATE TABLE IF NOT EXISTS private_trial_invite_events_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invite_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'redeemed', 'revoked', 'expired')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, invite_id) REFERENCES private_trial_invites_v2(workspace_id, id)
);

ALTER TABLE private_trial_invite_events_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_trial_invite_events_v2 FORCE ROW LEVEL SECURITY;

DO $private_trial_invite_events_policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'private_trial_invite_events_v2'::regclass AND polname = 'private_trial_invite_events_v2_workspace_isolation') THEN
    CREATE POLICY private_trial_invite_events_v2_workspace_isolation ON private_trial_invite_events_v2
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
END
$private_trial_invite_events_policy$;

DO $private_trial_invite_events_triggers$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'private_trial_invite_events_v2'::regclass AND tgname = 'private_trial_invite_events_v2_append_only') THEN
    CREATE TRIGGER private_trial_invite_events_v2_append_only BEFORE UPDATE OR DELETE ON private_trial_invite_events_v2 FOR EACH ROW EXECUTE FUNCTION reject_commercial_contract_fact_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'private_trial_invite_events_v2'::regclass AND tgname = 'private_trial_invite_events_v2_no_truncate') THEN
    CREATE TRIGGER private_trial_invite_events_v2_no_truncate BEFORE TRUNCATE ON private_trial_invite_events_v2 FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_contract_fact_mutation();
  END IF;
END
$private_trial_invite_events_triggers$;

DO $private_trial_invite_events_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON private_trial_invite_events_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON private_trial_invite_events_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON private_trial_invite_events_v2 TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON private_trial_invite_events_v2 FROM merchant_ops;
  END IF;
END
$private_trial_invite_events_acl$;
