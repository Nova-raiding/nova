-- Platform workspace directory is a control-plane projection. Keep its
-- underlying tenant tables behind the migration owner and expose only the
-- bounded summary to the isolated merchant_ops role.
CREATE OR REPLACE VIEW ops_workspace_summaries
WITH (security_barrier = true) AS
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
    REVOKE ALL ON TABLE ops_workspace_summaries FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON TABLE ops_workspace_summaries TO merchant_ops;
  END IF;
END
$$;
