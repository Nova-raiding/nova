-- 179_campaign_item_task_scope_integrity: a campaign item task link must be
-- reciprocal.  The existing FK only proves that task_id exists; it does not
-- prove that the task belongs to this campaign item.  Do not rewrite legacy
-- business rows: reject installation when an existing link is ambiguous and
-- fail closed for every future insert/update.

DO $$
DECLARE invalid_count bigint;
BEGIN
  SELECT count(*) INTO invalid_count
    FROM public.batch_campaign_items item
    JOIN public.tasks task
      ON task.workspace_id = item.workspace_id
     AND task.id = item.task_id
   WHERE item.task_id IS NOT NULL
     AND (
       task.campaign_id IS DISTINCT FROM item.campaign_id
       OR task.campaign_item_id IS DISTINCT FROM item.id
       OR task.product_id IS DISTINCT FROM item.legacy_product_id
       OR task.brand_id IS DISTINCT FROM item.brand_id
       OR task.canonical_product_id IS DISTINCT FROM item.canonical_product_id
       OR task.listing_id IS DISTINCT FROM item.listing_id
       OR task.platform IS DISTINCT FROM item.platform
       OR task.platform_account_id IS DISTINCT FROM item.platform_account_id
     );
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'migration 179 blocked: % campaign item task links have mismatched task scope', invalid_count;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_campaign_item_task_scope_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE task_scope record;
BEGIN
  IF NEW.task_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT campaign_id, campaign_item_id, product_id, brand_id,
         canonical_product_id, listing_id, platform, platform_account_id
    INTO task_scope
    FROM public.tasks
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.task_id;

  IF NOT FOUND
     OR task_scope.campaign_id IS DISTINCT FROM NEW.campaign_id
     OR task_scope.campaign_item_id IS DISTINCT FROM NEW.id
     OR task_scope.product_id IS DISTINCT FROM NEW.legacy_product_id
     OR task_scope.brand_id IS DISTINCT FROM NEW.brand_id
     OR task_scope.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id
     OR task_scope.listing_id IS DISTINCT FROM NEW.listing_id
     OR task_scope.platform IS DISTINCT FROM NEW.platform
     OR task_scope.platform_account_id IS DISTINCT FROM NEW.platform_account_id THEN
    RAISE EXCEPTION 'campaign item task scope does not match task scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS batch_campaign_items_task_scope_integrity
  ON public.batch_campaign_items;
CREATE TRIGGER batch_campaign_items_task_scope_integrity
BEFORE INSERT OR UPDATE OF workspace_id, campaign_id, brand_id,
  canonical_product_id, listing_id, legacy_product_id, platform,
  platform_account_id, task_id
ON public.batch_campaign_items
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_item_task_scope_integrity();

REVOKE ALL ON FUNCTION enforce_campaign_item_task_scope_integrity() FROM PUBLIC;
