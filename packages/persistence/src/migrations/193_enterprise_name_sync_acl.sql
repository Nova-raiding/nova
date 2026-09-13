-- 193_enterprise_name_sync_acl: keep enterprise display-name projection
-- writable only through the isolated platform-operations credential.
--
-- merchant_ops intentionally has no UPDATE privilege on enterprises.  The
-- password-auth repository still needs to synchronize a reviewed merchant's
-- display name, so expose a narrowly-scoped SECURITY DEFINER boundary that
-- accepts active workspace ids and updates only their canonical enterprise.
-- The caller must establish the same transaction-local platform scope used by
-- every other control-plane operation.

CREATE OR REPLACE FUNCTION public.sync_enterprise_name_for_workspaces(
  p_workspace_ids text[],
  p_enterprise_name text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  requested_workspace_id text;
  enterprise_id text;
  normalized_name text := btrim(coalesce(p_enterprise_name, ''));
  prior_workspace_id text := current_setting('app.workspace_id', true);
  updated_count integer := 0;
  changed_count integer;
BEGIN
  -- SECURITY DEFINER changes current_user to the migration owner.  Use
  -- session_user for the caller check and keep the scope check explicit.
  IF session_user <> 'merchant_ops'
     OR current_setting('app.platform_scope', true) IS DISTINCT FROM 'platform_ops' THEN
    RAISE EXCEPTION 'platform scope required for enterprise name sync'
      USING ERRCODE = '42501';
  END IF;

  IF p_workspace_ids IS NULL
     OR coalesce(array_length(p_workspace_ids, 1), 0) = 0 THEN
    RETURN 0;
  END IF;

  IF normalized_name = '' OR length(normalized_name) > 200 THEN
    RAISE EXCEPTION 'enterprise name is invalid'
      USING ERRCODE = '22023';
  END IF;

  FOREACH requested_workspace_id IN ARRAY p_workspace_ids LOOP
    requested_workspace_id := btrim(coalesce(requested_workspace_id, ''));
    IF requested_workspace_id = '' THEN
      RAISE EXCEPTION 'workspace id is invalid'
        USING ERRCODE = '22023';
    END IF;

    -- The latest workspace policy permits exactly this row when the
    -- transaction-local workspace id is set, even though the SECURITY
    -- DEFINER owner is not merchant_ops and does not bypass RLS.
    PERFORM set_config('app.workspace_id', requested_workspace_id, true);
    SELECT workspace.enterprise_id
      INTO enterprise_id
      FROM public.workspaces AS workspace
     WHERE workspace.id = requested_workspace_id
       AND workspace.status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'workspace is missing or inactive'
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.enterprises AS enterprise
       SET name = normalized_name
     WHERE enterprise.id = enterprise_id
       AND enterprise.name IS DISTINCT FROM normalized_name;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    updated_count := updated_count + changed_count;
  END LOOP;

  -- Do not leak the helper's temporary workspace scope to later statements
  -- in the caller's transaction (or to a pooled connection on an error path).
  IF prior_workspace_id IS NULL THEN
    RESET app.workspace_id;
  ELSE
    PERFORM set_config('app.workspace_id', prior_workspace_id, true);
  END IF;
  RETURN updated_count;
EXCEPTION
  WHEN OTHERS THEN
    IF prior_workspace_id IS NULL THEN
      RESET app.workspace_id;
    ELSE
      PERFORM set_config('app.workspace_id', prior_workspace_id, true);
    END IF;
    RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_enterprise_name_for_workspaces(text[], text)
  FROM PUBLIC;

DO $grant_enterprise_name_sync$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT EXECUTE ON FUNCTION public.sync_enterprise_name_for_workspaces(text[], text)
      TO merchant_ops;
  END IF;
END
$grant_enterprise_name_sync$;

COMMENT ON FUNCTION public.sync_enterprise_name_for_workspaces(text[], text)
  IS 'Platform-scoped enterprise display-name projection for reviewed merchant workspaces.';
