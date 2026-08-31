-- 069_platform_account_scope_integrity: prevent legacy business rows from
-- pairing a platform with an account belonging to another platform.

CREATE UNIQUE INDEX IF NOT EXISTS platform_accounts_workspace_platform_id_key
  ON platform_accounts (workspace_id, platform, id);

CREATE OR REPLACE FUNCTION assert_platform_account_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.platform_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_accounts account
     WHERE account.workspace_id = NEW.workspace_id
       AND account.id = NEW.platform_account_id
       AND account.platform = NEW.platform
  ) THEN
    RAISE EXCEPTION 'platform account scope mismatch: % / % / %', NEW.workspace_id, NEW.platform, NEW.platform_account_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_platform_account_scope ON products;
CREATE TRIGGER products_platform_account_scope
  BEFORE INSERT OR UPDATE OF workspace_id, platform, platform_account_id ON products
  FOR EACH ROW EXECUTE FUNCTION assert_platform_account_scope();

DROP TRIGGER IF EXISTS tasks_platform_account_scope ON tasks;
CREATE TRIGGER tasks_platform_account_scope
  BEFORE INSERT OR UPDATE OF workspace_id, platform, platform_account_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION assert_platform_account_scope();

DROP TRIGGER IF EXISTS publish_jobs_platform_account_scope ON publish_jobs;
CREATE TRIGGER publish_jobs_platform_account_scope
  BEFORE INSERT OR UPDATE OF workspace_id, platform, platform_account_id ON publish_jobs
  FOR EACH ROW EXECUTE FUNCTION assert_platform_account_scope();

REVOKE ALL ON FUNCTION assert_platform_account_scope() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON FUNCTION assert_platform_account_scope() FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON FUNCTION assert_platform_account_scope() FROM merchant_ops;
  END IF;
END $$;
