-- 194_lock_workspace_enterprise_binding: a tenant runtime may not rebind a
-- workspace to another enterprise.  The local compatibility bootstrap grants
-- broad workspace UPDATE privileges for legacy fields; a trigger is the
-- forward-only guard that keeps the tenant boundary immutable even while that
-- compatibility grant remains in place.

CREATE OR REPLACE FUNCTION public.prevent_workspace_enterprise_rebind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.enterprise_id IS DISTINCT FROM OLD.enterprise_id
     AND session_user IN ('merchant_app', 'merchant_ops') THEN
    RAISE EXCEPTION 'workspace enterprise binding is immutable for runtime roles'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS workspaces_enterprise_binding_immutable ON workspaces;
CREATE TRIGGER workspaces_enterprise_binding_immutable
  BEFORE UPDATE OF enterprise_id ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_workspace_enterprise_rebind();

REVOKE ALL ON FUNCTION public.prevent_workspace_enterprise_rebind() FROM PUBLIC;

COMMENT ON FUNCTION public.prevent_workspace_enterprise_rebind()
  IS 'Prevents merchant runtime roles from moving a workspace across enterprise boundaries.';
