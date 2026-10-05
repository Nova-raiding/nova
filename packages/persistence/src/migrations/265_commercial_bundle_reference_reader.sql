-- 265: expose a bounded, platform-scoped reference projection for approved Ops.
-- Both current catalog wiring and immutable order snapshots are returned so
-- historical purchases remain discoverable after later catalog changes.
CREATE FUNCTION merchant_ops_benefit_bundle_references_v3(
  p_code text,
  p_version_id text DEFAULT NULL,
  p_after_id text DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF (session_user <> 'merchant_ops' AND current_setting('role',true) IS DISTINCT FROM 'merchant_ops')
     OR current_setting('app.platform_scope',true) IS DISTINCT FROM 'platform_ops' THEN
    RAISE EXCEPTION 'platform operations scope required' USING ERRCODE='42501';
  END IF;
  IF nullif(btrim(p_code),'') IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'valid bundle code and page limit from 1 to 100 required' USING ERRCODE='22023';
  END IF;

  WITH refs AS (
    SELECT 'sku:'||r.sku_version_id||':'||r.bundle_version_id AS id,
           'sku'::text AS reference_kind,r.bundle_version_id AS bundle_version_id,
           r.sku_version_id AS sku_version_id,s.code AS sku_code,
           NULL::text AS workspace_id,NULL::text AS order_id
      FROM public.commercial_catalog_bundle_refs_v3 r
      JOIN public.commercial_benefit_bundle_versions_v3 bv ON bv.id=r.bundle_version_id
      JOIN public.commercial_benefit_bundles_v3 b ON b.id=bv.bundle_id
      JOIN public.commercial_catalog_sku_versions sv ON sv.id=r.sku_version_id
      JOIN public.commercial_catalog_skus s ON s.id=sv.sku_id
     WHERE b.code=p_code AND (p_version_id IS NULL OR bv.id=p_version_id)
    UNION ALL
    SELECT 'order:'||os.workspace_id||':'||o.id||':'||bv.id AS id,
           'order'::text AS reference_kind,bv.id AS bundle_version_id,
           os.sku_version_id AS sku_version_id,os.snapshot->'sku'->>'code' AS sku_code,
           os.workspace_id,o.id AS order_id
      FROM public.commercial_order_snapshots_v2 os
      JOIN public.commercial_orders_v2 o ON o.workspace_id=os.workspace_id AND o.id=os.order_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(os.snapshot->'sku'->'payload'->'bundleRefs')='array'
             THEN os.snapshot->'sku'->'payload'->'bundleRefs' ELSE '[]'::jsonb END
      ) AS frozen(reference)
      JOIN public.commercial_benefit_bundle_versions_v3 bv ON bv.id=frozen.reference->>'versionId'
      JOIN public.commercial_benefit_bundles_v3 b ON b.id=bv.bundle_id
     WHERE b.code=p_code AND (p_version_id IS NULL OR bv.id=p_version_id)
  ), checked_cursor AS (
    SELECT 1 FROM refs WHERE id=p_after_id
  ), page AS (
    SELECT refs.*,row_number() OVER (ORDER BY id COLLATE "C") AS ordinal
      FROM refs
     WHERE p_after_id IS NULL OR id COLLATE "C">p_after_id COLLATE "C"
     ORDER BY id COLLATE "C"
     LIMIT p_limit+1
  )
  SELECT jsonb_build_object(
    'items',COALESCE((SELECT jsonb_agg(to_jsonb(page)-'ordinal' ORDER BY page.id COLLATE "C") FROM page WHERE ordinal<=p_limit),'[]'::jsonb),
    'total',(SELECT count(*) FROM refs),
    'next_after_id',CASE WHEN (SELECT count(*) FROM page)>p_limit
                         THEN (SELECT id FROM page WHERE ordinal=p_limit) ELSE NULL END,
    'cursor_exists',EXISTS(SELECT 1 FROM checked_cursor)
  ) INTO result;
  IF p_after_id IS NOT NULL AND NOT (result->>'cursor_exists')::boolean THEN
    RAISE EXCEPTION 'bundle reference cursor does not identify a record in this filter' USING ERRCODE='22023';
  END IF;
  RETURN result-'cursor_exists';
END;
$$;
REVOKE ALL ON FUNCTION merchant_ops_benefit_bundle_references_v3(text,text,text,integer) FROM PUBLIC;
DO $acl$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
    GRANT EXECUTE ON FUNCTION merchant_ops_benefit_bundle_references_v3(text,text,text,integer) TO merchant_ops;
  END IF;
END $acl$;
