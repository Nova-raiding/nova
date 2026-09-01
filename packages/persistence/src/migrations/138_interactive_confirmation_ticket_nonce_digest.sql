ALTER TABLE interactive_confirmation_tickets
  ADD COLUMN IF NOT EXISTS nonce_digest_version SMALLINT NOT NULL DEFAULT 1
  CHECK (nonce_digest_version IN (1, 2));

COMMENT ON COLUMN interactive_confirmation_tickets.nonce_digest_version IS
  '1=legacy mixed storage; 2=nonce_hash stores SHA-256 of the client bearer';

ALTER TABLE interactive_confirmation_tickets
  ALTER COLUMN nonce_digest_version SET DEFAULT 2;

REVOKE UPDATE (nonce_digest_version) ON interactive_confirmation_tickets FROM PUBLIC;

DO $interactive_confirmation_ticket_nonce_digest_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE INSERT ON interactive_confirmation_tickets FROM merchant_app;
    GRANT INSERT (workspace_id, actor_id, session_id, intent_hash, nonce_hash, expires_at)
      ON interactive_confirmation_tickets TO merchant_app;
    REVOKE UPDATE (nonce_digest_version) ON interactive_confirmation_tickets FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE UPDATE (nonce_digest_version) ON interactive_confirmation_tickets FROM merchant_ops;
  END IF;
END
$interactive_confirmation_ticket_nonce_digest_acl$;
