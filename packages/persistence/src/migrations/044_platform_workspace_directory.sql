-- Platform operators need an explicit, transaction-local path to enumerate
-- workspace metadata. Tenant requests never set app.platform_scope.
DROP POLICY IF EXISTS workspaces_workspace_isolation ON workspaces;
CREATE POLICY workspaces_workspace_isolation ON workspaces
  USING (
    id = current_setting('app.workspace_id', true)
    OR current_setting('app.platform_scope', true) = 'platform_ops'
  )
  WITH CHECK (id = current_setting('app.workspace_id', true));
