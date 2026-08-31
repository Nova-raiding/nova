CREATE TABLE IF NOT EXISTS interactive_confirmation_tickets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_id TEXT NOT NULL CHECK (
    actor_id = btrim(actor_id)
    AND length(actor_id) BETWEEN 1 AND 255
    AND actor_id !~ '[[:cntrl:]]'
  ),
  session_id TEXT NOT NULL CHECK (
    session_id = btrim(session_id)
    AND length(session_id) BETWEEN 1 AND 512
    AND session_id !~ '[[:cntrl:]]'
  ),
  intent_hash TEXT NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash TEXT NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (nonce_hash)
);

CREATE INDEX IF NOT EXISTS interactive_confirmation_tickets_workspace_expiry_idx
  ON interactive_confirmation_tickets (workspace_id, expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE interactive_confirmation_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactive_confirmation_tickets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS interactive_confirmation_tickets_workspace_isolation ON interactive_confirmation_tickets;
CREATE POLICY interactive_confirmation_tickets_workspace_isolation ON interactive_confirmation_tickets
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION prevent_interactive_confirmation_ticket_reuse()
RETURNS trigger
LANGUAGE plpgsql
AS $interactive_confirmation_ticket_guard$
BEGIN
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'interactive confirmation ticket is already consumed';
  END IF;
  IF NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'interactive confirmation ticket consumption cannot be cleared';
  END IF;
  RETURN NEW;
END
$interactive_confirmation_ticket_guard$;

DROP TRIGGER IF EXISTS interactive_confirmation_ticket_one_time_guard ON interactive_confirmation_tickets;
CREATE TRIGGER interactive_confirmation_ticket_one_time_guard
BEFORE UPDATE OF consumed_at ON interactive_confirmation_tickets
FOR EACH ROW EXECUTE FUNCTION prevent_interactive_confirmation_ticket_reuse();

REVOKE ALL ON TABLE interactive_confirmation_tickets FROM PUBLIC;
DO $interactive_confirmation_ticket_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE interactive_confirmation_tickets FROM merchant_app;
    GRANT SELECT, INSERT ON TABLE interactive_confirmation_tickets TO merchant_app;
    GRANT UPDATE (consumed_at) ON TABLE interactive_confirmation_tickets TO merchant_app;
    REVOKE DELETE, TRUNCATE ON TABLE interactive_confirmation_tickets FROM merchant_app;
    REVOKE ALL ON FUNCTION prevent_interactive_confirmation_ticket_reuse() FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON TABLE interactive_confirmation_tickets FROM merchant_ops;
    REVOKE ALL ON FUNCTION prevent_interactive_confirmation_ticket_reuse() FROM merchant_ops;
  END IF;
END
$interactive_confirmation_ticket_acl$;

REVOKE ALL ON FUNCTION prevent_interactive_confirmation_ticket_reuse() FROM PUBLIC;
