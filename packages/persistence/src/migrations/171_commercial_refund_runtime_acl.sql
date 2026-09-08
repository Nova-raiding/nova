-- 171_commercial_refund_runtime_acl: keep tenant refund writes on the
-- RLS-constrained runtime role and remove direct Ops writes.
--
-- Migration 170 granted INSERT to merchant_ops even though the repository is
-- constructed with DATABASE_URL (merchant_app). Repair forward-only because
-- 170 may already be recorded in production migration history.

DO $commercial_refund_runtime_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON commercial_refund_events_v2 FROM merchant_ops;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT ON commercial_refund_events_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON commercial_refund_events_v2 FROM merchant_app;
  END IF;
END
$commercial_refund_runtime_acl$;
