-- Add the tenant boundary policy required by the runtime RLS catalog check.
-- Keep the existing platform-ops policy from migration 210: PostgreSQL
-- combines permissive policies with OR, so merchant_ops retains its explicit
-- platform scope while tenant-scoped sessions can never cross workspaces.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'mcp_oauth_authorization_codes'
       AND policyname = 'mcp_oauth_authorization_codes_workspace_isolation'
  ) THEN
    CREATE POLICY mcp_oauth_authorization_codes_workspace_isolation
      ON mcp_oauth_authorization_codes
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'mcp_oauth_tokens'
       AND policyname = 'mcp_oauth_tokens_workspace_isolation'
  ) THEN
    CREATE POLICY mcp_oauth_tokens_workspace_isolation
      ON mcp_oauth_tokens
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
END
$migration$;
