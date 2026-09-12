-- 186_harden_runtime_auth_acl: keep identity and password-auth state on the
-- isolated Ops role. Forward-only and idempotent; no business data changes.

DO $runtime_auth_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON platform_identities, platform_identity_events,
      platform_auth_sessions, platform_password_accounts,
      platform_password_sessions, platform_password_reset_tokens
      FROM merchant_app;
  END IF;
END
$runtime_auth_acl$;
