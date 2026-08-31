-- 106_canonical_legacy_brand_integrity_guard: close the NULL-brand hole left
-- by the MATCH SIMPLE composite FK introduced in migration 099.
-- Existing invalid data is a deployment blocker. This migration deliberately
-- does not rewrite or delete business rows.

DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM canonical_products cp
  LEFT JOIN products p
    ON p.workspace_id = cp.workspace_id
   AND p.id = cp.legacy_product_id
  WHERE cp.legacy_product_id IS NOT NULL
    AND (p.id IS NULL OR p.brand_id IS NULL OR cp.workspace_id IS NULL OR cp.brand_id IS NULL OR cp.brand_id IS DISTINCT FROM p.brand_id);
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'migration 106 blocked: % invalid canonical legacy brand mappings', invalid_count;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_canonical_legacy_brand_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE legacy_brand_id text;
BEGIN
  IF NEW.legacy_product_id IS NULL THEN RETURN NEW; END IF;
  SELECT p.brand_id INTO legacy_brand_id FROM public.products p
    WHERE p.workspace_id = NEW.workspace_id AND p.id = NEW.legacy_product_id FOR KEY SHARE;
  IF NOT FOUND OR legacy_brand_id IS NULL THEN
    RAISE EXCEPTION 'canonical legacy product must have a non-null brand' USING ERRCODE = '23514';
  END IF;
  IF NEW.brand_id IS DISTINCT FROM legacy_brand_id THEN
    RAISE EXCEPTION 'canonical and legacy product brands must match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS canonical_products_legacy_brand_integrity_guard ON canonical_products;
CREATE TRIGGER canonical_products_legacy_brand_integrity_guard
BEFORE INSERT OR UPDATE OF workspace_id, brand_id, legacy_product_id ON canonical_products
FOR EACH ROW EXECUTE FUNCTION enforce_canonical_legacy_brand_integrity();
ALTER TABLE canonical_products ENABLE ALWAYS TRIGGER canonical_products_legacy_brand_integrity_guard;
ALTER TABLE canonical_products VALIDATE CONSTRAINT canonical_products_brand_legacy_fk;
