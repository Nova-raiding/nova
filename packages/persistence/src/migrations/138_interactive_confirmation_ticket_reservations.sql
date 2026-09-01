ALTER TABLE interactive_confirmation_tickets
  ADD COLUMN IF NOT EXISTS reservation_id TEXT,
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ;

ALTER TABLE interactive_confirmation_tickets
  DROP CONSTRAINT IF EXISTS interactive_confirmation_ticket_reservation_shape,
  ADD CONSTRAINT interactive_confirmation_ticket_reservation_shape CHECK (
    (reservation_id IS NULL AND reserved_at IS NULL AND reservation_expires_at IS NULL)
    OR (
      reservation_id IS NOT NULL
      AND reservation_id = btrim(reservation_id)
      AND length(reservation_id) BETWEEN 1 AND 255
      AND reservation_id !~ '[[:cntrl:]]'
      AND reserved_at IS NOT NULL
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at > reserved_at
      AND reservation_expires_at <= expires_at
    )
  );

CREATE INDEX IF NOT EXISTS interactive_confirmation_tickets_active_reservation_idx
  ON interactive_confirmation_tickets (workspace_id, reservation_expires_at)
  WHERE consumed_at IS NULL AND reservation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_interactive_confirmation_ticket_reuse()
RETURNS trigger
LANGUAGE plpgsql
AS $interactive_confirmation_ticket_guard$
BEGIN
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'interactive confirmation ticket is already consumed';
  END IF;
  IF OLD.consumed_at IS DISTINCT FROM NEW.consumed_at AND NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'interactive confirmation ticket consumption cannot be cleared';
  END IF;
  RETURN NEW;
END
$interactive_confirmation_ticket_guard$;

DROP TRIGGER IF EXISTS interactive_confirmation_ticket_one_time_guard ON interactive_confirmation_tickets;
CREATE TRIGGER interactive_confirmation_ticket_one_time_guard
BEFORE UPDATE OF consumed_at, reservation_id, reserved_at, reservation_expires_at ON interactive_confirmation_tickets
FOR EACH ROW EXECUTE FUNCTION prevent_interactive_confirmation_ticket_reuse();

REVOKE ALL ON TABLE interactive_confirmation_tickets FROM PUBLIC;
DO $interactive_confirmation_ticket_reservation_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT UPDATE (consumed_at, reservation_id, reserved_at, reservation_expires_at)
      ON TABLE interactive_confirmation_tickets TO merchant_app;
    REVOKE UPDATE (workspace_id, actor_id, session_id, intent_hash, nonce_hash, expires_at)
      ON TABLE interactive_confirmation_tickets FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON TABLE interactive_confirmation_tickets FROM merchant_ops;
  END IF;
END
$interactive_confirmation_ticket_reservation_acl$;

REVOKE ALL ON FUNCTION prevent_interactive_confirmation_ticket_reuse() FROM PUBLIC;
