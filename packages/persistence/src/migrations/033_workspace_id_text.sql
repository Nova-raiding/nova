-- 033_workspace_id_text: align later workspace-scoped tables with the
-- canonical workspaces.id type. Workspace IDs are opaque tenant strings
-- (for example, ws_demo), not UUIDs.
DO $$
DECLARE
  table_name text;
  constraint_name text;
BEGIN
  -- PostgreSQL policies depend on the column type in their expressions. They
  -- must be removed before ALTER COLUMN, then recreated below after all
  -- workspace_id columns have been converted to opaque tenant text IDs.
  DROP POLICY IF EXISTS workspace_commercial_settings_isolation ON workspace_commercial_settings;
  DROP POLICY IF EXISTS workspace_platform_settings_isolation ON workspace_platform_settings;
  DROP POLICY IF EXISTS workspace_usage_ledger_isolation ON workspace_usage_ledger;
  DROP POLICY IF EXISTS workspace_operation_audit_isolation ON workspace_operation_audit;
  DROP POLICY IF EXISTS workspace_subscriptions_isolation ON workspace_subscriptions;
  DROP POLICY IF EXISTS workspace_subscription_orders_isolation ON workspace_subscription_orders;
  DROP POLICY IF EXISTS workspace_members_isolation ON workspace_members;
  DROP POLICY IF EXISTS workspace_growth_events_workspace_isolation ON workspace_growth_events;
  DROP POLICY IF EXISTS workspace_operation_alerts_isolation ON workspace_operation_alerts;
  DROP POLICY IF EXISTS workspace_data_deletion_requests_isolation ON workspace_data_deletion_requests;
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_commercial_settings',
    'workspace_platform_settings',
    'workspace_usage_ledger',
    'workspace_operation_audit',
    'workspace_subscriptions',
    'workspace_subscription_orders',
    'workspace_members',
    'workspace_growth_events',
    'workspace_operation_alerts',
    'workspace_data_deletion_requests'
  ] LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      constraint_name := table_name || '_workspace_id_fkey';
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', table_name, constraint_name);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id TYPE text USING workspace_id::text', table_name);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE', table_name, constraint_name);
    END IF;
  END LOOP;
END $$;

DROP POLICY IF EXISTS workspace_commercial_settings_isolation ON workspace_commercial_settings;
DROP POLICY IF EXISTS workspace_platform_settings_isolation ON workspace_platform_settings;
DROP POLICY IF EXISTS workspace_usage_ledger_isolation ON workspace_usage_ledger;
DROP POLICY IF EXISTS workspace_operation_audit_isolation ON workspace_operation_audit;
DROP POLICY IF EXISTS workspace_subscriptions_isolation ON workspace_subscriptions;
DROP POLICY IF EXISTS workspace_subscription_orders_isolation ON workspace_subscription_orders;
DROP POLICY IF EXISTS workspace_members_isolation ON workspace_members;
DROP POLICY IF EXISTS workspace_growth_events_workspace_isolation ON workspace_growth_events;
DROP POLICY IF EXISTS workspace_operation_alerts_isolation ON workspace_operation_alerts;
DROP POLICY IF EXISTS workspace_data_deletion_requests_isolation ON workspace_data_deletion_requests;

CREATE POLICY workspace_commercial_settings_isolation ON workspace_commercial_settings
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_platform_settings_isolation ON workspace_platform_settings
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_usage_ledger_isolation ON workspace_usage_ledger
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_operation_audit_isolation ON workspace_operation_audit
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_subscriptions_isolation ON workspace_subscriptions
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_subscription_orders_isolation ON workspace_subscription_orders
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_members_isolation ON workspace_members
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_growth_events_workspace_isolation ON workspace_growth_events
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_operation_alerts_isolation ON workspace_operation_alerts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY workspace_data_deletion_requests_isolation ON workspace_data_deletion_requests
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
