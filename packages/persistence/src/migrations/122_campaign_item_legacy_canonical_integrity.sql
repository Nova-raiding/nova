-- 122_campaign_item_legacy_canonical_integrity: keep the compatibility
-- product id aligned with the canonical product on new batch-item writes.
-- Existing rows are intentionally not rewritten or validated here.

CREATE OR REPLACE FUNCTION enforce_campaign_item_legacy_canonical_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  canonical_legacy_product_id text;
BEGIN
  IF NEW.legacy_product_id IS NULL OR NEW.canonical_product_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT legacy_product_id INTO canonical_legacy_product_id
    FROM public.canonical_products
   WHERE workspace_id = NEW.workspace_id
     AND id = NEW.canonical_product_id;

  IF NOT FOUND OR canonical_legacy_product_id IS DISTINCT FROM NEW.legacy_product_id THEN
    RAISE EXCEPTION 'campaign item legacy and canonical products must match'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS batch_campaign_items_legacy_canonical_integrity
  ON batch_campaign_items;
CREATE TRIGGER batch_campaign_items_legacy_canonical_integrity
BEFORE INSERT OR UPDATE OF workspace_id, legacy_product_id, canonical_product_id
ON batch_campaign_items
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_item_legacy_canonical_integrity();

REVOKE ALL ON FUNCTION enforce_campaign_item_legacy_canonical_integrity() FROM PUBLIC;
