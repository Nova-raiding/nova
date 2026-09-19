-- 223_merchant_catalog_projection: capability-trimmed read path for the tenant
-- runtime onto the global commercial catalog.
--
-- Migration 146 already states the intent: "Merchant runtime must consume a
-- capability-trimmed application response; it never receives direct access to
-- global catalog base tables." That REVOKE was a no-op in every deployed
-- environment, because the migrate container entrypoint runs
-- `ensure-app-role.sql` both before and after the migration chain, and the
-- second run ends with `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN
-- SCHEMA public TO merchant_app`. The blanket grant silently re-armed the six
-- catalog base tables for `merchant_app`, the production runtime role.
--
-- Making that REVOKE real requires replacing the three runtime reads that
-- relied on the accidental grant, so this migration installs the replacement
-- projection first and the bootstrap re-asserts the deny list afterwards:
--
--   * `merchant_entitlement_snapshots_v2(p_limit)` — the entitlement snapshot
--     list (`listEntitlementSnapshots`) joins the catalog only to resolve
--     `commercial_catalog_skus.code`. This is the single read path behind
--     `ContinuousFeatureEntitlementService.decide`; losing it turns every
--     non-recovery operation into COMMERCIAL_ENTITLEMENT_UNAVAILABLE.
--   * `merchant_onboarding_sku_v2()` — the private-trial conversion path
--     resolves the one approved executable `onboarding_once` SKU version.
--
-- Both functions are the established 051/066 SECURITY DEFINER shape: the
-- function owner resolves the catalog, `SET row_security = off` keeps the
-- forced-RLS policy from re-filtering the owner's rows, and `SET search_path =
-- pg_catalog` pins every name so a caller cannot shadow a catalog relation.
--
-- SECURITY: `row_security = off` means neither function inherits the caller's
-- tenant scope from the RLS policies on the v2 tables. A SECURITY DEFINER
-- function that read `workspace_entitlement_snapshots_v2` without its own
-- predicate would return every workspace's entitlement snapshots to any caller
-- that can execute it — a cross-tenant read. Every tenant-scoped function
-- below therefore carries the explicit
-- `WHERE workspace_id = current_setting('app.workspace_id', true)` predicate
-- that duplicates the `workspace_id = current_setting('app.workspace_id')`
-- policy from 153. When the setting is absent `current_setting(..., true)`
-- yields NULL, the comparison yields NULL, and the function returns no rows.
--
-- `merchant_onboarding_sku_v2()` is deliberately not tenant-scoped: it reads
-- the workspace-independent global catalog, and it only ever returns the
-- single approved, executable, publicly-visible `onboarding_once` snapshot.
--
-- This migration only creates functions, revokes PUBLIC access and grants
-- EXECUTE. It performs no concurrent index build, so it carries no
-- `-- migrate:no-transaction` marker and the runner keeps its default
-- transactional posture (see `packages/persistence/src/migration.ts`).

CREATE OR REPLACE FUNCTION public.merchant_entitlement_snapshots_v2(p_limit integer)
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
  SELECT
    e.id,
    e.workspace_id,
    e.subscription_period_id,
    p.period_start,
    p.period_end,
    p.status,
    e.catalog_version_id,
    s.code,
    e.resolved_benefits,
    e.unresolved_blockers,
    e.executable,
    e.checksum,
    e.created_at
  FROM public.workspace_entitlement_snapshots_v2 AS e
  JOIN public.workspace_subscription_periods_v2 AS p
    ON p.workspace_id = e.workspace_id AND p.id = e.subscription_period_id
  JOIN public.commercial_catalog_sku_versions AS v ON v.id = e.catalog_version_id
  JOIN public.commercial_catalog_skus AS s ON s.id = v.sku_id
  WHERE e.workspace_id = current_setting('app.workspace_id', true)
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200)
$function$;

CREATE OR REPLACE FUNCTION public.merchant_onboarding_sku_v2()
RETURNS TABLE (
  id text,
  code text,
  kind text,
  visibility text,
  required_capability text,
  version_id text,
  version integer,
  lifecycle text,
  executable boolean,
  price_fen bigint,
  currency text,
  price_mode text,
  duration_days integer,
  payload jsonb,
  checksum text,
  effective_at timestamptz,
  benefits jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
  SELECT
    s.id,
    s.code,
    s.kind,
    s.visibility,
    s.required_capability,
    v.id,
    v.version,
    v.lifecycle,
    v.executable,
    v.price_fen,
    v.currency,
    v.price_mode,
    v.duration_days,
    v.payload,
    v.checksum,
    v.effective_at,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'code', b.benefit_code,
        'quantity', b.quantity,
        'rawValue', b.raw_value,
        'rawUnit', b.raw_unit,
        'normalizedValue', b.normalized_value,
        'policyRef', b.policy_ref,
        'metadata', b.metadata
      ) ORDER BY b.benefit_code)
      FROM public.commercial_catalog_sku_benefits AS b
      WHERE b.sku_version_id = v.id
    ), '[]'::jsonb)
  FROM public.commercial_catalog_skus AS s
  JOIN public.commercial_catalog_sku_versions AS v ON v.sku_id = s.id
  WHERE s.code = 'onboarding_once'
    AND s.kind = 'onboarding'
    AND v.lifecycle = 'approved'
    AND v.executable = true
    AND v.effective_at <= now()
  ORDER BY v.version DESC
  LIMIT 2
$function$;

-- PUBLIC never receives EXECUTE; the tenant runtime is the only grantee. The
-- second `ensure-app-role.sql` run revokes EXECUTE on every public function
-- from `merchant_app`, so the same script re-grants these two entry points
-- next to `worker_active_workspace_catalog`.
REVOKE ALL ON FUNCTION public.merchant_entitlement_snapshots_v2(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merchant_onboarding_sku_v2() FROM PUBLIC;

DO $merchant_catalog_projection_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT EXECUTE ON FUNCTION public.merchant_entitlement_snapshots_v2(integer) TO merchant_app;
    GRANT EXECUTE ON FUNCTION public.merchant_onboarding_sku_v2() TO merchant_app;
  END IF;
END
$merchant_catalog_projection_acl$;

COMMENT ON FUNCTION public.merchant_entitlement_snapshots_v2(integer) IS
  'Workspace-scoped entitlement snapshot list for the tenant runtime; replaces the catalog join that migration 146 revokes.';
COMMENT ON FUNCTION public.merchant_onboarding_sku_v2() IS
  'The single approved executable onboarding_once SKU snapshot for the private-trial conversion path; no tenant dimension.';
