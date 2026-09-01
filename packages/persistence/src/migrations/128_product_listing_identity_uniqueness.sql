-- 128_product_listing_identity_uniqueness: make the listing five-tuple a
-- database invariant. The repository check remains a useful error message,
-- but cannot protect writes from another process or a direct SQL client.
-- Existing duplicates are deliberately a migration blocker; this migration
-- never rewrites or deletes business data.

DO $$
DECLARE duplicate_count bigint;
BEGIN
  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT workspace_id, brand_id, canonical_product_id, platform,
           platform_account_id
    FROM product_listings
    GROUP BY workspace_id, brand_id, canonical_product_id, platform,
             platform_account_id
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'migration 128 blocked: % duplicate product listing identities', duplicate_count;
  END IF;
END
$$;

CREATE UNIQUE INDEX product_listings_canonical_identity_key
  ON product_listings (
    workspace_id,
    brand_id,
    canonical_product_id,
    platform,
    platform_account_id
  );
