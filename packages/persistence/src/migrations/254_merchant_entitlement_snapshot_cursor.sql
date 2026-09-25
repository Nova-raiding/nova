-- Adds a keyset-pagination variant without changing the legacy function used by
-- older runtimes. The API only selects this function after the 254 migration
-- is present, so rollback keeps the database forward-only and safe.
CREATE OR REPLACE FUNCTION public.merchant_entitlement_snapshots_v3(
  p_limit integer,
  p_after_created_at timestamptz DEFAULT NULL,
  p_after_id text DEFAULT NULL
)
RETURNS TABLE (
  id text,
  workspace_id text,
  subscription_period_id text,
  period_start timestamptz,
  period_end timestamptz,
  period_status text,
  catalog_version_id text,
  sku_code text,
  resolved_benefits jsonb,
  unresolved_blockers jsonb,
  executable boolean,
  checksum text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
  SELECT e.id, e.workspace_id, e.subscription_period_id, p.period_start, p.period_end,
         p.status, e.catalog_version_id, s.code, e.resolved_benefits,
         e.unresolved_blockers, e.executable, e.checksum, e.created_at
    FROM public.workspace_entitlement_snapshots_v2 AS e
    JOIN public.workspace_subscription_periods_v2 AS p
      ON p.workspace_id=e.workspace_id AND p.id=e.subscription_period_id
    JOIN public.commercial_catalog_sku_versions AS v ON v.id=e.catalog_version_id
    JOIN public.commercial_catalog_skus AS s ON s.id=v.sku_id
   WHERE e.workspace_id=current_setting('app.workspace_id', true)
     AND (p_after_created_at IS NULL OR (e.created_at,e.id) < (p_after_created_at,p_after_id))
   ORDER BY e.created_at DESC,e.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 201)
$function$;

REVOKE ALL ON FUNCTION public.merchant_entitlement_snapshots_v3(integer,timestamptz,text) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
    GRANT EXECUTE ON FUNCTION public.merchant_entitlement_snapshots_v3(integer,timestamptz,text) TO merchant_app;
  END IF;
  -- Local Compose runs the API as the single `merchant` login role. Keep its
  -- explicit grant aligned with the production app role without widening the
  -- function to PUBLIC.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant') THEN
    GRANT EXECUTE ON FUNCTION public.merchant_entitlement_snapshots_v3(integer,timestamptz,text) TO merchant;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN
    GRANT EXECUTE ON FUNCTION public.merchant_entitlement_snapshots_v3(integer,timestamptz,text) TO merchant_ops;
  END IF;
END
$grant$;
