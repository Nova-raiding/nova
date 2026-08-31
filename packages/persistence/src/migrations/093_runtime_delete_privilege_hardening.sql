-- 093_runtime_delete_privilege_hardening: converge permissions for roles that
-- existed before the per-migration GRANT/REVOKE blocks were introduced.
-- RLS limits rows, but it does not make DELETE safe for the application role.
DO $runtime_delete_privilege_hardening$
DECLARE
  table_name TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    FOREACH table_name IN ARRAY ARRAY['canonical_products', 'product_listings', 'image_generation_executions'] LOOP
      IF to_regclass(table_name) IS NOT NULL THEN
        EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE %I FROM merchant_app', table_name);
      END IF;
    END LOOP;
  END IF;
END
$runtime_delete_privilege_hardening$;
