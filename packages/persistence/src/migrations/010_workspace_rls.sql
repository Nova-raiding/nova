-- 010_workspace_rls: protect workspace directory metadata with the same
-- tenant scope as every business table. The API sets app.workspace_id before
-- any workspace insert/read; startup must not enumerate all tenants.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_workspace_isolation ON workspaces;
CREATE POLICY workspaces_workspace_isolation ON workspaces
  USING (id = current_setting('app.workspace_id', true))
  WITH CHECK (id = current_setting('app.workspace_id', true));
