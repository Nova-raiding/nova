-- 152_authorization_grant_scope_integrity: keep durable grants bound to the
-- exact workspace they authorize, even when a privileged writer bypasses the
-- application repository.

CREATE OR REPLACE FUNCTION validate_ops_access_grant_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.resource_scope->>'type' IS DISTINCT FROM 'workspace'
     OR jsonb_typeof(NEW.resource_scope->'ids') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.resource_scope->'ids') <> 1
     OR NEW.resource_scope->'ids'->>0 IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'ops access grant scope is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ops_access_grants_scope_integrity ON ops_access_grants;
CREATE TRIGGER ops_access_grants_scope_integrity
BEFORE INSERT OR UPDATE OF workspace_id, resource_scope ON ops_access_grants
FOR EACH ROW EXECUTE FUNCTION validate_ops_access_grant_scope();
