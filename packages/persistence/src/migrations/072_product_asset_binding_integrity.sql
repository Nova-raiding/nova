-- 072_product_asset_binding_integrity: preserve curated roles while syncing
-- the legacy sourceAssetIds projection, and reject malformed/cross-tenant IDs.

CREATE OR REPLACE FUNCTION validate_product_asset_binding_asset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.business_entity_snapshots asset
     WHERE asset.workspace_id = NEW.workspace_id
       AND asset.entity_type = 'asset'
       AND asset.entity_id = NEW.asset_id
  ) THEN
    RAISE EXCEPTION 'asset % does not exist in workspace %', NEW.asset_id, NEW.workspace_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_asset_bindings_asset_validate ON product_asset_bindings;
CREATE TRIGGER product_asset_bindings_asset_validate
  BEFORE INSERT OR UPDATE OF workspace_id, asset_id ON product_asset_bindings
  FOR EACH ROW EXECUTE FUNCTION validate_product_asset_binding_asset();

CREATE OR REPLACE FUNCTION sync_product_asset_bindings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_ids jsonb := CASE
    WHEN jsonb_typeof(NEW.data->'sourceAssetIds') = 'array' THEN NEW.data->'sourceAssetIds'
    ELSE '[]'::jsonb
  END;
BEGIN
  -- The legacy JSON field owns only source bindings. Curated main/secondary/
  -- detail roles and explicit disabled states are preserved across product edits.
  UPDATE public.product_asset_bindings binding
     SET status = 'disabled', updated_at = now()
   WHERE binding.workspace_id = NEW.workspace_id
     AND binding.product_id = NEW.id
     AND binding.asset_role = 'source'
     AND binding.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(source_ids) WITH ORDINALITY desired(value, ordinal)
        WHERE btrim(desired.value) <> ''
          AND desired.value = binding.asset_id
     );

  INSERT INTO public.product_asset_bindings (workspace_id, product_id, asset_id, ordinal)
  SELECT NEW.workspace_id, NEW.id, desired.value, desired.ordinal::integer
    FROM jsonb_array_elements_text(source_ids) WITH ORDINALITY desired(value, ordinal)
   WHERE btrim(desired.value) <> ''
     AND EXISTS (
       SELECT 1 FROM public.business_entity_snapshots asset
        WHERE asset.workspace_id = NEW.workspace_id
          AND asset.entity_type = 'asset'
          AND asset.entity_id = desired.value
     )
  ON CONFLICT (workspace_id, product_id, asset_id, asset_role)
  DO UPDATE SET ordinal = EXCLUDED.ordinal, updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION validate_product_asset_binding_asset() FROM PUBLIC;
