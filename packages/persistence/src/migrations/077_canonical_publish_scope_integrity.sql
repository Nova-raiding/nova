-- 077_canonical_publish_scope_integrity: close the canonical binding boundary
-- for new writes. Legacy rows remain readable and are not rewritten.

CREATE OR REPLACE FUNCTION assert_task_canonical_publish_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  canonical record;
  listing record;
BEGIN
  IF NEW.canonical_product_id IS NOT NULL THEN
    SELECT id, workspace_id, brand_id, legacy_product_id
      INTO canonical
      FROM public.canonical_products
     WHERE workspace_id = NEW.workspace_id AND id = NEW.canonical_product_id;
    IF NOT FOUND OR (NEW.brand_id IS NOT NULL AND canonical.brand_id IS DISTINCT FROM NEW.brand_id)
       OR (canonical.legacy_product_id IS NOT NULL AND canonical.legacy_product_id IS DISTINCT FROM NEW.product_id) THEN
      RAISE EXCEPTION 'task canonical binding mismatch: % / % / %', NEW.workspace_id, NEW.product_id, NEW.canonical_product_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.listing_id IS NOT NULL THEN
    SELECT canonical_product_id, brand_id, platform, platform_account_id
      INTO listing
      FROM public.product_listings
     WHERE workspace_id = NEW.workspace_id AND id = NEW.listing_id;
    IF NOT FOUND OR listing.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id
       OR listing.brand_id IS DISTINCT FROM NEW.brand_id
       OR listing.platform IS DISTINCT FROM NEW.platform
       OR listing.platform_account_id IS DISTINCT FROM NEW.platform_account_id THEN
      RAISE EXCEPTION 'task listing binding mismatch: % / % / %', NEW.workspace_id, NEW.product_id, NEW.listing_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_canonical_publish_scope ON tasks;
CREATE TRIGGER tasks_canonical_publish_scope
  BEFORE INSERT OR UPDATE OF workspace_id, product_id, platform, platform_account_id, brand_id, canonical_product_id, listing_id
  ON tasks FOR EACH ROW EXECUTE FUNCTION assert_task_canonical_publish_scope();

CREATE OR REPLACE FUNCTION assert_publish_job_task_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  task record;
BEGIN
  SELECT platform, platform_account_id
    INTO task
    FROM public.tasks
   WHERE workspace_id = NEW.workspace_id AND id = NEW.task_id;
  IF NOT FOUND OR task.platform IS DISTINCT FROM NEW.platform
     OR task.platform_account_id IS DISTINCT FROM NEW.platform_account_id THEN
    RAISE EXCEPTION 'publish job task scope mismatch: % / % / %', NEW.workspace_id, NEW.task_id, NEW.platform_account_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS publish_jobs_task_scope ON publish_jobs;
CREATE TRIGGER publish_jobs_task_scope
  BEFORE INSERT OR UPDATE OF workspace_id, task_id, platform, platform_account_id
  ON publish_jobs FOR EACH ROW EXECUTE FUNCTION assert_publish_job_task_scope();

CREATE INDEX IF NOT EXISTS publish_jobs_task_scope_idx
  ON publish_jobs (workspace_id, task_id, platform, platform_account_id, updated_at DESC);

REVOKE ALL ON FUNCTION assert_task_canonical_publish_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_publish_job_task_scope() FROM PUBLIC;
