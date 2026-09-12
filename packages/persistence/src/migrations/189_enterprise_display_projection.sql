-- 189_enterprise_display_projection: use the durable enterprise name as the
-- operator-facing identity while preserving workspace IDs as technical scope.
--
-- Password-auth accounts already carried the enterprise name before the
-- enterprise root was introduced. Backfill the canonical enterprise row from
-- the most recently updated merchant account that is bound to that enterprise.
UPDATE enterprises e
SET name = source.enterprise_name
FROM (
  SELECT DISTINCT ON (w.enterprise_id)
    w.enterprise_id,
    NULLIF(btrim(a.enterprise_name), '') AS enterprise_name
  FROM workspaces w
  JOIN platform_password_accounts a
    ON w.id = ANY(a.workspace_ids)
  WHERE a.account_type = 'merchant'
    AND NULLIF(btrim(a.enterprise_name), '') IS NOT NULL
  ORDER BY w.enterprise_id, a.updated_at DESC, a.id DESC
) source
WHERE e.id = source.enterprise_id
  AND source.enterprise_name IS NOT NULL;

DROP POLICY IF EXISTS enterprises_workspace_scope ON enterprises;
CREATE POLICY enterprises_workspace_scope ON enterprises
  USING (
    current_setting('app.platform_scope', true) = 'platform_ops'
    OR EXISTS (
      SELECT 1
      FROM workspaces scoped_workspace
      WHERE scoped_workspace.enterprise_id = enterprises.id
        AND scoped_workspace.id = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.platform_scope', true) = 'platform_ops'
    OR EXISTS (
      SELECT 1
      FROM workspaces scoped_workspace
      WHERE scoped_workspace.enterprise_id = enterprises.id
        AND scoped_workspace.id = current_setting('app.workspace_id', true)
    )
  );
