-- Migration 239 was already applied before the merchant_app revocation was
-- introduced. Keep applied migration history immutable and carry the security
-- tightening in this forward-only migration.
DO $$
BEGIN
  IF to_regclass('public.mcp_oauth_authorization_codes') IS NOT NULL THEN
    REVOKE ALL ON mcp_oauth_authorization_codes FROM PUBLIC, merchant_app;
  END IF;
  IF to_regclass('public.mcp_oauth_tokens') IS NOT NULL THEN
    REVOKE ALL ON mcp_oauth_tokens FROM PUBLIC, merchant_app;
  END IF;
END
$$;
