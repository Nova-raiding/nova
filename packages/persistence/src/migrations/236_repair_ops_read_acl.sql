-- Restored production databases may retain migration history while losing the
-- grants installed by the original ops-scope migrations.  Repair only the
-- bounded read surfaces used by the Ops pool and commercial readiness checks.
DO $$
DECLARE
  relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'workspaces', 'workspace_members', 'workspace_commercial_settings',
    'workspace_subscriptions', 'billing_orders', 'billing_transactions',
    'workspace_subscription_orders', 'workspace_usage_ledger',
    'model_usage_ledger', 'commercial_catalog_skus',
    'commercial_catalog_sku_versions', 'commercial_catalog_sku_benefits',
    'creative_point_rate_card_versions_v2', 'creative_point_rate_rules_v2',
    'commercial_catalog_events_v2'
  ] LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE %I TO merchant_ops', relation_name);
    END IF;
  END LOOP;
END
$$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON commercial_catalog_skus, commercial_catalog_sku_versions,
     commercial_catalog_sku_benefits, creative_point_rate_card_versions_v2,
     creative_point_rate_rules_v2, commercial_catalog_events_v2
  FROM merchant_ops;
