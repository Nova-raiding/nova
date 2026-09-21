-- Restored production databases may retain migration history while losing the
-- control-plane grants that let the isolated Ops role authenticate and inspect
-- identities. Repair only the historical grants; do not widen merchant_app or
-- change any identity data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    IF to_regclass('public.platform_identities') IS NOT NULL THEN
      GRANT SELECT, INSERT, UPDATE ON platform_identities TO merchant_ops;
    END IF;
    IF to_regclass('public.platform_auth_sessions') IS NOT NULL THEN
      GRANT SELECT, INSERT, UPDATE ON platform_auth_sessions TO merchant_ops;
    END IF;
    IF to_regclass('public.platform_identity_events') IS NOT NULL THEN
      GRANT SELECT, INSERT ON platform_identity_events TO merchant_ops;
    END IF;
    IF to_regclass('public.platform_password_accounts') IS NOT NULL THEN
      GRANT SELECT, INSERT, UPDATE ON platform_password_accounts TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON platform_password_accounts FROM merchant_ops;
    END IF;
    IF to_regclass('public.platform_password_sessions') IS NOT NULL THEN
      GRANT SELECT, INSERT, UPDATE ON platform_password_sessions TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON platform_password_sessions FROM merchant_ops;
    END IF;
    IF to_regclass('public.platform_password_reset_tokens') IS NOT NULL THEN
      GRANT SELECT, INSERT, UPDATE ON platform_password_reset_tokens TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON platform_password_reset_tokens FROM merchant_ops;
    END IF;
  END IF;
END
$$;
