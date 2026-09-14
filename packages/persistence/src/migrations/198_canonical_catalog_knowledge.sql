-- Canonical catalog hierarchy: product -> listing(platform/store) -> SKU.
-- canonical_products and product_listings are provided by migration 039_multi_brand_batch.
CREATE UNIQUE INDEX IF NOT EXISTS product_listings_product_identity_idx ON product_listings(workspace_id,canonical_product_id,id);
CREATE TABLE IF NOT EXISTS canonical_skus (
  id TEXT NOT NULL, workspace_id TEXT NOT NULL, canonical_product_id TEXT NOT NULL,
  name TEXT NOT NULL, specification TEXT NOT NULL, base_price NUMERIC(18,2) NOT NULL CHECK (base_price >= 0), currency CHAR(3) NOT NULL DEFAULT 'CNY', revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,canonical_product_id,id), FOREIGN KEY (workspace_id,canonical_product_id) REFERENCES canonical_products(workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS listing_skus (
  id TEXT NOT NULL, workspace_id TEXT NOT NULL, listing_id TEXT NOT NULL, canonical_product_id TEXT NOT NULL, canonical_sku_id TEXT NOT NULL,
  remote_sku_id TEXT, price NUMERIC(18,2) NOT NULL CHECK (price IS NULL OR price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id), UNIQUE (workspace_id,listing_id,canonical_sku_id), UNIQUE (workspace_id,listing_id,remote_sku_id),
  FOREIGN KEY (workspace_id,canonical_product_id,listing_id) REFERENCES product_listings(workspace_id,canonical_product_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,canonical_product_id,canonical_sku_id) REFERENCES canonical_skus(workspace_id,canonical_product_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS source_image_bindings (
  id TEXT NOT NULL, workspace_id TEXT NOT NULL, asset_id TEXT NOT NULL, asset_entity_type TEXT NOT NULL DEFAULT 'asset' CHECK (asset_entity_type = 'asset'), listing_id TEXT NOT NULL,
  canonical_product_id TEXT NOT NULL, canonical_sku_id TEXT NOT NULL, usage TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size <= 104857600),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,asset_entity_type,asset_id) REFERENCES business_entity_snapshots(workspace_id,entity_type,entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,canonical_product_id) REFERENCES canonical_products(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,canonical_product_id,listing_id) REFERENCES product_listings(workspace_id,canonical_product_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,canonical_product_id,canonical_sku_id) REFERENCES canonical_skus(workspace_id,canonical_product_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS canonical_products_workspace_idx ON canonical_products(workspace_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS source_image_bindings_lookup_idx ON source_image_bindings(workspace_id,canonical_product_id,listing_id,canonical_sku_id);
DO $rls$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['canonical_skus','listing_skus','source_image_bindings'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t); EXECUTE format('CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true))',t||'_workspace_isolation',t); END LOOP; END $rls$;
