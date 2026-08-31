-- 063_product_listing_brand_canonical_integrity: prevent a listing from
-- combining a brand with a canonical product owned by another brand in the
-- same workspace. The preflight fails closed instead of rewriting bad data.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM product_listings listing
    LEFT JOIN canonical_products canonical
      ON canonical.workspace_id = listing.workspace_id
     AND canonical.brand_id = listing.brand_id
     AND canonical.id = listing.canonical_product_id
    WHERE canonical.id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'product_listings contains a cross-brand canonical product reference';
  END IF;
END
$$;

ALTER TABLE product_listings
  ADD CONSTRAINT product_listings_brand_canonical_fk
  FOREIGN KEY (workspace_id, brand_id, canonical_product_id)
  REFERENCES canonical_products (workspace_id, brand_id, id)
  NOT VALID;

ALTER TABLE product_listings
  VALIDATE CONSTRAINT product_listings_brand_canonical_fk;
