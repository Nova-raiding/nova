-- 051_active_workspace_catalog: expose the minimum cross-tenant directory
-- needed by WORKER_WORKSPACES=auto without weakening workspace RLS.
CREATE OR REPLACE FUNCTION public.worker_active_workspace_catalog()
RETURNS TABLE (workspace_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
  SELECT workspace.id AS workspace_id
  FROM public.workspaces AS workspace
  WHERE workspace.status = 'active'
  ORDER BY workspace.id
$function$;

REVOKE ALL ON FUNCTION public.worker_active_workspace_catalog() FROM PUBLIC;

COMMENT ON FUNCTION public.worker_active_workspace_catalog() IS
  'Read-only active workspace ID catalog for authorized background-worker roles.';
