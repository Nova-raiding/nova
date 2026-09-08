-- 165_object_storage_orphan_runtime_acl: keep the published migration 043
-- immutable while granting the runtime worker only the orphan-queue actions
-- used by the durable cleanup repository.

REVOKE ALL ON TABLE object_storage_orphans FROM PUBLIC;

DO $object_storage_orphan_runtime_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE object_storage_orphans TO merchant_app;
    REVOKE DELETE, TRUNCATE ON TABLE object_storage_orphans FROM merchant_app;
  END IF;
END
$object_storage_orphan_runtime_acl$;
