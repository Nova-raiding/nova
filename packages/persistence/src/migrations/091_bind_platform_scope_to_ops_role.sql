-- 091_bind_platform_scope_to_ops_role: a tenant connection must never be
-- able to turn a transaction-local GUC into a platform-wide grant. Platform
-- reads use the separately credentialed merchant_ops pool.

DROP POLICY IF EXISTS workspaces_workspace_isolation ON workspaces;
CREATE POLICY workspaces_workspace_isolation ON workspaces
  USING (id = current_setting('app.workspace_id', true)
    OR (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops'))
  WITH CHECK (id = current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS workspace_members_select_scope ON workspace_members;
CREATE POLICY workspace_members_select_scope ON workspace_members FOR SELECT
  USING (workspace_id = current_setting('app.workspace_id', true)
    OR (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops'));

DROP POLICY IF EXISTS workspace_commercial_settings_select_scope ON workspace_commercial_settings;
CREATE POLICY workspace_commercial_settings_select_scope ON workspace_commercial_settings FOR SELECT
  USING (workspace_id = current_setting('app.workspace_id', true)
    OR (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops'));

DROP POLICY IF EXISTS workspace_subscriptions_select_scope ON workspace_subscriptions;
CREATE POLICY workspace_subscriptions_select_scope ON workspace_subscriptions FOR SELECT
  USING (workspace_id = current_setting('app.workspace_id', true)
    OR (current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops'));

DROP POLICY IF EXISTS platform_identities_scope ON platform_identities;
CREATE POLICY platform_identities_scope ON platform_identities
  USING ((current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
    OR (issuer = current_setting('app.identity_issuer', true) AND external_subject = current_setting('app.identity_subject', true)))
  WITH CHECK ((current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
    OR (issuer = current_setting('app.identity_issuer', true) AND external_subject = current_setting('app.identity_subject', true)));

DROP POLICY IF EXISTS platform_auth_sessions_scope ON platform_auth_sessions;
CREATE POLICY platform_auth_sessions_scope ON platform_auth_sessions
  USING ((current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
    OR identity_id::text = current_setting('app.identity_id', true))
  WITH CHECK ((current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
    OR identity_id::text = current_setting('app.identity_id', true));

DROP POLICY IF EXISTS platform_identity_events_scope ON platform_identity_events;
CREATE POLICY platform_identity_events_scope ON platform_identity_events
  USING ((current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
    OR identity_id::text = current_setting('app.identity_id', true))
  WITH CHECK ((current_user = 'merchant_ops' AND current_setting('app.platform_scope', true) = 'platform_ops')
    OR identity_id::text = current_setting('app.identity_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON workspaces, workspace_members, workspace_commercial_settings, workspace_subscriptions TO merchant_ops;
    GRANT SELECT, INSERT, UPDATE ON platform_identities, platform_auth_sessions TO merchant_ops;
    GRANT SELECT, INSERT ON platform_identity_events TO merchant_ops;
    GRANT SELECT ON billing_orders, billing_transactions, workspace_subscription_orders, workspace_usage_ledger, model_usage_ledger TO merchant_ops;
  END IF;
END
$$;
