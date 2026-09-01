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
      AND reservation_token IS NOT NULL
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
  );

REVOKE UPDATE ON TABLE interactive_confirmation_tickets FROM merchant_app;
GRANT UPDATE (consumed_at, consumed_operation_id, reservation_id, reservation_token,
  reservation_revision, reserved_at, reservation_expires_at)
  ON TABLE interactive_confirmation_tickets TO merchant_app;
REVOKE DELETE, TRUNCATE ON TABLE interactive_confirmation_tickets FROM merchant_app;
