-- 073_ops_data_contracts: make the platform-operations workspace directory
-- complete without weakening tenant writes.  Ops may read the two relations
-- needed by the workspace summary, while every mutation remains tied to the
-- transaction-local workspace scope.

DROP POLICY IF EXISTS workspace_commercial_settings_isolation ON workspace_commercial_settings;
DROP POLICY IF EXISTS workspace_commercial_settings_select_scope ON workspace_commercial_settings;
DROP POLICY IF EXISTS workspace_commercial_settings_insert_scope ON workspace_commercial_settings;
DROP POLICY IF EXISTS workspace_commercial_settings_update_scope ON workspace_commercial_settings;
DROP POLICY IF EXISTS workspace_commercial_settings_delete_scope ON workspace_commercial_settings;
CREATE POLICY workspace_commercial_settings_select_scope ON workspace_commercial_settings FOR SELECT
  USING (
    workspace_id = current_setting('app.workspace_id', true)
    OR current_setting('app.platform_scope', true) = 'platform_ops'
  );
CREATE POLICY workspace_commercial_settings_insert_scope ON workspace_commercial_settings FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_commercial_settings_update_scope ON workspace_commercial_settings FOR UPDATE
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_commercial_settings_delete_scope ON workspace_commercial_settings FOR DELETE
  USING (workspace_id = current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS workspace_subscriptions_isolation ON workspace_subscriptions;
DROP POLICY IF EXISTS workspace_subscriptions_select_scope ON workspace_subscriptions;
DROP POLICY IF EXISTS workspace_subscriptions_insert_scope ON workspace_subscriptions;
DROP POLICY IF EXISTS workspace_subscriptions_update_scope ON workspace_subscriptions;
DROP POLICY IF EXISTS workspace_subscriptions_delete_scope ON workspace_subscriptions;
CREATE POLICY workspace_subscriptions_select_scope ON workspace_subscriptions FOR SELECT
  USING (
    workspace_id = current_setting('app.workspace_id', true)
    OR current_setting('app.platform_scope', true) = 'platform_ops'
  );
CREATE POLICY workspace_subscriptions_insert_scope ON workspace_subscriptions FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_subscriptions_update_scope ON workspace_subscriptions FOR UPDATE
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_subscriptions_delete_scope ON workspace_subscriptions FOR DELETE
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE VIEW ops_workspace_summaries
WITH (security_barrier = true, security_invoker = true) AS
  SELECT
    w.id AS workspace_id,
    w.status,
    COALESCE(c.plan_name, 'Starter') AS plan_name,
    COALESCE(c.monthly_price_cny, 199)::double precision AS monthly_price_cny,
    COALESCE(c.monthly_tasks_used, 0)::integer AS used_tasks,
    COALESCE(c.included_tasks, 30)::integer AS included_tasks,
    COALESCE(s.status, 'trialing') AS subscription_status,
    count(m.id)::integer AS member_count,
    w.created_at
  FROM workspaces w
  LEFT JOIN workspace_commercial_settings c ON c.workspace_id = w.id
  LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
  LEFT JOIN workspace_members m ON m.workspace_id = w.id
  GROUP BY
    w.id, w.status, c.plan_name, c.monthly_price_cny,
    c.monthly_tasks_used, c.included_tasks, s.status, w.created_at;

REVOKE ALL ON TABLE ops_workspace_summaries FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT ON TABLE ops_workspace_summaries TO merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON TABLE ops_workspace_summaries FROM merchant_ops;
  END IF;
END
$$;
