-- Restore the ops-only reservation ACL after a dump/restore that preserved
-- schema data but omitted role grants. This is idempotent and row-preserving.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON authorization_execution_reservations FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT ON authorization_execution_reservations TO merchant_ops;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON authorization_execution_reservations FROM merchant_ops;
  END IF;
END $$;
