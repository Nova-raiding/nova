-- 070_product_asset_bindings: make product -> asset references queryable
-- while legacy sourceAssetIds remains a compatibility projection.

CREATE TABLE IF NOT EXISTS product_asset_bindings (
  workspace_id text NOT NULL,
  product_id text NOT NULL,
  asset_id text NOT NULL,
  asset_role text NOT NULL DEFAULT 'source' CHECK (asset_role IN ('source', 'main', 'secondary', 'detail')),
  ordinal integer NOT NULL DEFAULT 1 CHECK (ordinal > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, product_id, asset_id, asset_role),
  CONSTRAINT product_asset_bindings_product_fk FOREIGN KEY (workspace_id, product_id)
    REFERENCES products (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS product_asset_bindings_product_idx
  ON product_asset_bindings (workspace_id, product_id, status, asset_role, ordinal);
CREATE INDEX IF NOT EXISTS product_asset_bindings_asset_idx
  ON product_asset_bindings (workspace_id, asset_id, status, product_id);

ALTER TABLE product_asset_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_asset_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_asset_bindings_workspace_isolation ON product_asset_bindings;
CREATE POLICY product_asset_bindings_workspace_isolation ON product_asset_bindings
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Assets are currently compatibility snapshots rather than a normalized table,
-- so the trigger validates existence and tenant scope against that snapshot.
CREATE OR REPLACE FUNCTION sync_product_asset_bindings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.product_asset_bindings
   WHERE workspace_id = NEW.workspace_id AND product_id = NEW.id;
  INSERT INTO public.product_asset_bindings (workspace_id, product_id, asset_id, ordinal)
  SELECT NEW.workspace_id, NEW.id, value, ordinality::integer
    FROM jsonb_array_elements_text(COALESCE(NEW.data->'sourceAssetIds', '[]'::jsonb)) WITH ORDINALITY
   WHERE btrim(value) <> ''
     AND EXISTS (
       SELECT 1 FROM public.business_entity_snapshots asset
        WHERE asset.workspace_id = NEW.workspace_id
          AND asset.entity_type = 'asset'
          AND asset.entity_id = value
     )
  ON CONFLICT (workspace_id, product_id, asset_id, asset_role)
  DO UPDATE SET ordinal = EXCLUDED.ordinal, status = 'active', updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_asset_bindings_sync ON products;
CREATE TRIGGER products_asset_bindings_sync
  AFTER INSERT OR UPDATE OF data ON products
  FOR EACH ROW EXECUTE FUNCTION sync_product_asset_bindings();

-- Backfill only provable same-workspace asset snapshot references. Unresolved
-- legacy IDs remain in the compatibility payload and are intentionally not
-- fabricated into a relation row.
INSERT INTO product_asset_bindings (workspace_id, product_id, asset_id, ordinal)
SELECT product.workspace_id, product.id, value, ordinality::integer
  FROM products product
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(product.data->'sourceAssetIds', '[]'::jsonb)) WITH ORDINALITY
 WHERE btrim(value) <> ''
   AND EXISTS (
     SELECT 1 FROM business_entity_snapshots asset
      WHERE asset.workspace_id = product.workspace_id
        AND asset.entity_type = 'asset'
        AND asset.entity_id = value
   )
ON CONFLICT (workspace_id, product_id, asset_id, asset_role) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE product_asset_bindings FROM merchant_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_asset_bindings TO merchant_app;
  END IF;
END $$;

REVOKE ALL ON FUNCTION sync_product_asset_bindings() FROM PUBLIC;
