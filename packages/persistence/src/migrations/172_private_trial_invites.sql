-- 172_private_trial_invites: durable allowlist/invite control for the private
-- 1999/7d validation offer.  The raw invite code is returned only once; the
-- database stores a SHA-256 digest and an append-only redemption fact.

CREATE TABLE private_trial_invites_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_ref TEXT NOT NULL,
  invite_code_hash TEXT NOT NULL CHECK (invite_code_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  redeemed_eligibility_id TEXT,
  issued_by_actor_id TEXT NOT NULL,
  evidence JSONB NOT NULL CHECK (evidence <> '{}'::jsonb),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, invite_code_hash),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, redeemed_eligibility_id) REFERENCES private_trial_eligibilities_v2(workspace_id, id),
  CHECK ((status = 'active' AND redeemed_at IS NULL AND redeemed_eligibility_id IS NULL)
      OR (status = 'redeemed' AND redeemed_at IS NOT NULL AND redeemed_eligibility_id IS NOT NULL)
      OR status = 'revoked'
      OR status = 'expired')
);

CREATE INDEX private_trial_invites_workspace_status_idx
  ON private_trial_invites_v2(workspace_id, status, expires_at);

ALTER TABLE private_trial_invites_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_trial_invites_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY private_trial_invites_v2_workspace_isolation ON private_trial_invites_v2
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DO $private_trial_invites_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON private_trial_invites_v2 TO merchant_app;
    REVOKE DELETE, TRUNCATE ON private_trial_invites_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON private_trial_invites_v2 TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON private_trial_invites_v2 FROM merchant_ops;
  END IF;
END
$private_trial_invites_acl$;
