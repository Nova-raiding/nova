-- 076_canonical_product_backfill_index: support workspace-scoped canonical
-- backfill/reporting without imposing uniqueness before legacy conflicts are
-- reviewed. The backfill never overwrites an existing canonical relation.
CREATE INDEX IF NOT EXISTS canonical_products_legacy_product_lookup_idx
  ON canonical_products (workspace_id, legacy_product_id, id)
  WHERE legacy_product_id IS NOT NULL;
