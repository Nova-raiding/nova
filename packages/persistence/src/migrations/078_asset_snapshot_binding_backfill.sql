-- 078_asset_snapshot_binding_backfill: close the late-asset write gap.
-- Products may be persisted before their asset snapshots arrive.  The legacy
-- sourceAssetIds projection remains the compatibility input, while this
-- trigger backfills only provable same-workspace source bindings.

CREATE OR REPLACE FUNCTION backfill_product_asset_bindings_for_asset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.entity_type <> 'asset' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.product_asset_bindings (workspace_id, product_id, asset_id, asset_role, ordinal, status)
  SELECT product.workspace_id, product.id, NEW.entity_id, 'source', desired.ordinal::integer, 'active'
    FROM public.products product
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(product.data->'sourceAssetIds') = 'array' THEN product.data->'sourceAssetIds'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY desired(value, ordinal)
   WHERE product.workspace_id = NEW.workspace_id
     AND btrim(desired.value) = NEW.entity_id
  ON CONFLICT (workspace_id, product_id, asset_id, asset_role)
  DO UPDATE SET ordinal = EXCLUDED.ordinal, updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS asset_snapshot_product_bindings_backfill ON business_entity_snapshots;
CREATE TRIGGER asset_snapshot_product_bindings_backfill
  AFTER INSERT OR UPDATE OF payload ON business_entity_snapshots
  FOR EACH ROW EXECUTE FUNCTION backfill_product_asset_bindings_for_asset();

REVOKE ALL ON FUNCTION backfill_product_asset_bindings_for_asset() FROM PUBLIC;

CREATE OR REPLACE FUNCTION remove_product_asset_bindings_for_asset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.entity_type = 'asset' THEN
    DELETE FROM public.product_asset_bindings
     WHERE workspace_id = OLD.workspace_id
       AND asset_id = OLD.entity_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS asset_snapshot_product_bindings_delete ON business_entity_snapshots;
CREATE TRIGGER asset_snapshot_product_bindings_delete
  AFTER DELETE ON business_entity_snapshots
  FOR EACH ROW EXECUTE FUNCTION remove_product_asset_bindings_for_asset();

REVOKE ALL ON FUNCTION remove_product_asset_bindings_for_asset() FROM PUBLIC;

-- Repair existing late-arriving assets without fabricating cross-workspace
-- relationships.  The product trigger remains authoritative for removals.
INSERT INTO product_asset_bindings (workspace_id, product_id, asset_id, asset_role, ordinal, status)
SELECT product.workspace_id, product.id, asset.entity_id, 'source', desired.ordinal::integer, 'active'
  FROM products product
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(product.data->'sourceAssetIds') = 'array' THEN product.data->'sourceAssetIds'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY desired(value, ordinal)
  JOIN business_entity_snapshots asset
    ON asset.workspace_id = product.workspace_id
   AND asset.entity_type = 'asset'
   AND asset.entity_id = desired.value
ON CONFLICT (workspace_id, product_id, asset_id, asset_role)
DO UPDATE SET ordinal = EXCLUDED.ordinal, updated_at = now();
