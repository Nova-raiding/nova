-- Restored production databases may retain the MCP OAuth schema while losing
-- migration 210's merchant_ops grants. Restore only that control-plane
-- contract; merchant_app remains denied.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    IF to_regclass('public.workspace_members') IS NOT NULL THEN
      GRANT SELECT ON workspace_members TO merchant_ops;
      GRANT UPDATE (identity_id, revision, updated_at) ON workspace_members TO merchant_ops;
    END IF;
    IF to_regclass('public.workspaces') IS NOT NULL THEN
      GRANT SELECT ON workspaces TO merchant_ops;
    END IF;
    IF to_regclass('public.mcp_oauth_authorization_codes') IS NOT NULL THEN
      REVOKE ALL ON mcp_oauth_authorization_codes FROM PUBLIC, merchant_app;
      GRANT SELECT, INSERT, UPDATE ON mcp_oauth_authorization_codes TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON mcp_oauth_authorization_codes FROM merchant_ops;
    END IF;
    IF to_regclass('public.mcp_oauth_tokens') IS NOT NULL THEN
      REVOKE ALL ON mcp_oauth_tokens FROM PUBLIC, merchant_app;
      GRANT SELECT, INSERT, UPDATE ON mcp_oauth_tokens TO merchant_ops;
      REVOKE DELETE, TRUNCATE ON mcp_oauth_tokens FROM merchant_ops;
    END IF;
  END IF;
END
$$;
