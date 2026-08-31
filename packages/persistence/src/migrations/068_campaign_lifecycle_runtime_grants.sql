-- 068_campaign_lifecycle_runtime_grants: allow the tenant runtime role to
-- operate durable campaign rows while forced workspace RLS remains authoritative.
REVOKE ALL ON TABLE batch_campaigns, batch_campaign_items FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE batch_campaigns, batch_campaign_items FROM merchant_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE batch_campaigns, batch_campaign_items TO merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON TABLE batch_campaigns, batch_campaign_items FROM merchant_ops;
  END IF;
END $$;
