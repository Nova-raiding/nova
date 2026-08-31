-- 099_canonical_legacy_brand_integrity: expose the legacy product brand
-- carried in data.brandId and prevent new cross-brand canonical mappings.
-- Existing rows are intentionally not rewritten or validated here. Conflict
-- inventory and remediation must happen before a later VALIDATE CONSTRAINT.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand_id text
  GENERATED ALWAYS AS (NULLIF(btrim(data->>'brandId'), '')) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS products_workspace_brand_identity_key
  ON products (workspace_id, id, brand_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_products_brand_legacy_fk'
      AND conrelid = 'canonical_products'::regclass
  ) THEN
    ALTER TABLE canonical_products
      ADD CONSTRAINT canonical_products_brand_legacy_fk
      FOREIGN KEY (workspace_id, brand_id, legacy_product_id)
      REFERENCES products (workspace_id, brand_id, id)
      NOT VALID;
  END IF;
END
$$;
