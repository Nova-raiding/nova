ALTER TABLE interactive_confirmation_tickets
  ADD COLUMN IF NOT EXISTS reservation_token TEXT,
  ADD COLUMN IF NOT EXISTS reservation_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS consumed_operation_id TEXT;

-- Fence leases created by v139. Their former owners never received this token,
-- so they cannot mutate the row after the v140 deployment takes ownership.
UPDATE interactive_confirmation_tickets
SET reservation_token = encode(gen_random_bytes(32), 'hex'),
    reservation_revision = 1
WHERE reservation_id IS NOT NULL
  AND reservation_token IS NULL;

-- Preserve historical consumption without pretending it was bound to a known
-- publish operation. Only old finalized reservations need a stable legacy tag.
UPDATE interactive_confirmation_tickets
SET consumed_operation_id = 'legacy-ticket:' || nonce_hash
WHERE consumed_at IS NOT NULL
  AND reservation_id IS NOT NULL
  AND consumed_operation_id IS NULL;

ALTER TABLE interactive_confirmation_tickets
  DROP CONSTRAINT IF EXISTS interactive_confirmation_ticket_reservation_shape,
  ADD CONSTRAINT interactive_confirmation_ticket_reservation_shape CHECK (
    (
      reservation_id IS NULL
      AND reservation_token IS NULL
      AND reserved_at IS NULL
      AND reservation_expires_at IS NULL
    )
    OR (
      reservation_id IS NOT NULL
      AND reservation_id = btrim(reservation_id)
      AND length(reservation_id) BETWEEN 1 AND 255
      AND reservation_id !~ '[[:cntrl:]]'
      AND reservation_token ~ '^[0-9a-f]{64}$'
      AND reservation_revision > 0
      AND reserved_at IS NOT NULL
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at > reserved_at
      AND reservation_expires_at <= expires_at
    )
  ),
  ADD CONSTRAINT interactive_confirmation_ticket_consumed_operation_shape CHECK (
    (consumed_at IS NULL AND consumed_operation_id IS NULL)
    OR (
      consumed_at IS NOT NULL
      AND (
        (reservation_id IS NULL AND consumed_operation_id IS NULL)
        OR (
          consumed_operation_id IS NOT NULL
          AND consumed_operation_id = btrim(consumed_operation_id)
          AND length(consumed_operation_id) BETWEEN 1 AND 255
          AND consumed_operation_id !~ '[[:cntrl:]]'
        )
      )
    )
  );

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
BEFORE UPDATE OF consumed_at, consumed_operation_id, reservation_id, reservation_token,
  reservation_revision, reserved_at, reservation_expires_at ON interactive_confirmation_tickets
FOR EACH ROW EXECUTE FUNCTION prevent_interactive_confirmation_ticket_reuse();

REVOKE ALL ON TABLE interactive_confirmation_tickets FROM PUBLIC;
DO $interactive_confirmation_ticket_fencing_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT UPDATE (consumed_at, consumed_operation_id, reservation_id, reservation_token,
      reservation_revision, reserved_at, reservation_expires_at)
      ON TABLE interactive_confirmation_tickets TO merchant_app;
    REVOKE UPDATE (workspace_id, actor_id, session_id, intent_hash, nonce_hash,
      nonce_digest_version, expires_at)
      ON TABLE interactive_confirmation_tickets FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON TABLE interactive_confirmation_tickets FROM merchant_ops;
  END IF;
END
$interactive_confirmation_ticket_fencing_acl$;

REVOKE ALL ON FUNCTION prevent_interactive_confirmation_ticket_reuse() FROM PUBLIC;
