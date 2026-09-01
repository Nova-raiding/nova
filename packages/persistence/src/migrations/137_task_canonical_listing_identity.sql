-- 137_task_canonical_listing_identity: a task that opts into the canonical
-- chain must carry one complete, identity-consistent target. Legacy-only
-- tasks remain readable during the additive migration.

CREATE OR REPLACE FUNCTION enforce_task_canonical_listing_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  canonical_scope record;
  listing_scope record;
BEGIN
  IF NEW.canonical_product_id IS NULL AND NEW.listing_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.canonical_product_id IS NULL
     OR NEW.listing_id IS NULL
     OR NEW.brand_id IS NULL
     OR NEW.platform_account_id IS NULL THEN
    RAISE EXCEPTION 'canonical task requires complete listing identity'
      USING ERRCODE = '23514';
  END IF;

  SELECT brand_id, legacy_product_id
    INTO canonical_scope
    FROM public.canonical_products
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.canonical_product_id;

  SELECT brand_id, canonical_product_id, platform, platform_account_id
    INTO listing_scope
    FROM public.product_listings
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.listing_id;

  IF NOT FOUND
     OR canonical_scope.brand_id IS DISTINCT FROM NEW.brand_id
     OR (canonical_scope.legacy_product_id IS NOT NULL
         AND canonical_scope.legacy_product_id IS DISTINCT FROM NEW.product_id)
     OR listing_scope.brand_id IS DISTINCT FROM NEW.brand_id
     OR listing_scope.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id
     OR listing_scope.platform IS DISTINCT FROM NEW.platform
     OR listing_scope.platform_account_id IS DISTINCT FROM NEW.platform_account_id THEN
    RAISE EXCEPTION 'canonical task listing identity does not match task scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_canonical_listing_identity ON tasks;
CREATE TRIGGER tasks_canonical_listing_identity
BEFORE INSERT OR UPDATE OF workspace_id, product_id, platform,
  platform_account_id, brand_id, canonical_product_id, listing_id
ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_canonical_listing_identity();

REVOKE ALL ON FUNCTION enforce_task_canonical_listing_identity() FROM PUBLIC;
