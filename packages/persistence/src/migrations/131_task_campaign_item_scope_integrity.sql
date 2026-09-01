-- 131_task_campaign_item_scope_integrity: a task attached to a campaign item
-- must carry the exact same canonical and execution scope. Legacy tasks without
-- campaign_item_id remain readable and are intentionally not rewritten.

CREATE OR REPLACE FUNCTION enforce_task_campaign_item_scope_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  item_scope record;
BEGIN
  IF NEW.campaign_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.campaign_id IS NULL
     OR NEW.brand_id IS NULL
     OR NEW.canonical_product_id IS NULL
     OR NEW.listing_id IS NULL
     OR NEW.platform_account_id IS NULL THEN
    RAISE EXCEPTION 'campaign task requires complete campaign item scope'
      USING ERRCODE = '23514';
  END IF;

  SELECT campaign_id, brand_id, canonical_product_id, listing_id,
         platform, platform_account_id, legacy_product_id
    INTO item_scope
    FROM public.batch_campaign_items
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.campaign_item_id;

  IF NOT FOUND
     OR item_scope.campaign_id IS DISTINCT FROM NEW.campaign_id
     OR item_scope.brand_id IS DISTINCT FROM NEW.brand_id
     OR item_scope.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id
     OR item_scope.listing_id IS DISTINCT FROM NEW.listing_id
     OR item_scope.platform IS DISTINCT FROM NEW.platform
     OR item_scope.platform_account_id IS DISTINCT FROM NEW.platform_account_id
     OR item_scope.legacy_product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'task campaign item scope does not match task scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_campaign_item_scope_integrity ON tasks;
CREATE TRIGGER tasks_campaign_item_scope_integrity
BEFORE INSERT OR UPDATE OF workspace_id, product_id, platform,
  platform_account_id, brand_id, canonical_product_id, listing_id,
  campaign_id, campaign_item_id
ON tasks
FOR EACH ROW EXECUTE FUNCTION enforce_task_campaign_item_scope_integrity();

REVOKE ALL ON FUNCTION enforce_task_campaign_item_scope_integrity() FROM PUBLIC;
