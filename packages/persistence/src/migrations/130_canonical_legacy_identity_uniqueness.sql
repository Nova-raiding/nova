-- 130_canonical_legacy_identity_uniqueness: a legacy product may resolve to
-- at most one canonical product within a workspace.  The consistency report
-- can describe an existing ambiguity, but the database must prevent new
-- ambiguous mappings from being committed by another writer or SQL client.
-- Existing duplicates are deliberately a migration blocker; this migration
-- never rewrites or deletes business data.

DO $$
DECLARE
  duplicate_count bigint;
BEGIN
  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT workspace_id, legacy_product_id
    FROM canonical_products
    WHERE legacy_product_id IS NOT NULL
    GROUP BY workspace_id, legacy_product_id
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'migration 130 blocked: % ambiguous canonical legacy mappings', duplicate_count;
  END IF;
END
$$;

CREATE UNIQUE INDEX canonical_products_workspace_legacy_identity_key
  ON canonical_products (workspace_id, legacy_product_id)
  WHERE legacy_product_id IS NOT NULL;
