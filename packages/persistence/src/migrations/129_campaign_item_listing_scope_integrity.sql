-- 129_campaign_item_listing_scope_integrity: standard campaign items must
-- point at the exact listing whose canonical and execution scope they carry.
-- Legacy-only items remain valid during the additive migration; any item that
-- opts into the canonical chain is fail-closed instead of being inferred.

CREATE OR REPLACE FUNCTION enforce_campaign_item_listing_scope_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  listing_scope record;
BEGIN
  IF NEW.canonical_product_id IS NULL AND NEW.listing_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.canonical_product_id IS NULL OR NEW.listing_id IS NULL THEN
    RAISE EXCEPTION 'canonical campaign item requires canonical_product_id and listing_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT brand_id, canonical_product_id, platform, platform_account_id
    INTO listing_scope
    FROM public.product_listings
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.listing_id;

  IF NOT FOUND
     OR listing_scope.brand_id IS DISTINCT FROM NEW.brand_id
     OR listing_scope.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id
     OR listing_scope.platform IS DISTINCT FROM NEW.platform
     OR listing_scope.platform_account_id IS DISTINCT FROM NEW.platform_account_id THEN
    RAISE EXCEPTION 'campaign item listing scope does not match canonical target'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS batch_campaign_items_listing_scope_integrity
  ON batch_campaign_items;
CREATE TRIGGER batch_campaign_items_listing_scope_integrity
BEFORE INSERT OR UPDATE OF workspace_id, brand_id, canonical_product_id,
  listing_id, platform, platform_account_id
ON batch_campaign_items
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_item_listing_scope_integrity();

REVOKE ALL ON FUNCTION enforce_campaign_item_listing_scope_integrity() FROM PUBLIC;
