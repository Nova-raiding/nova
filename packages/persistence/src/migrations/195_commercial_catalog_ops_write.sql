-- Allow the audited Ops API to append immutable catalog versions.
-- UPDATE/DELETE remain blocked by 146_commercial_catalog_v2 triggers.
DO $catalog_ops_write$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT INSERT ON commercial_catalog_skus,
      commercial_catalog_sku_versions,
      commercial_catalog_sku_benefits,
      commercial_catalog_events_v2 TO merchant_ops;
  END IF;
END
$catalog_ops_write$;
