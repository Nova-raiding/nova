-- 163_authorization_workspace_scope_contract: align new grants with the API's
-- exact workspace_ids contract. Never translate historical authority or its
-- scope hash/event snapshots. Operators must revoke and reissue incompatible
-- live grants explicitly before applying this migration.
-- MigrationRunner executes this audit and trigger replacement in one transaction.
LOCK TABLE ops_access_grants IN SHARE ROW EXCLUSIVE MODE;
-- An RLS-filtered audit must fail rather than silently overlook live grants.
SET LOCAL row_security = off;

DO $authorization_workspace_scope_audit$
DECLARE
  grant_row RECORD;
BEGIN
  -- Exhausted grants can still authorize already-admitted work; future-issued
  -- grants can become usable later. Neither is safe to omit from this audit.
  FOR grant_row IN
    SELECT workspace_id, resource_scope FROM ops_access_grants
    WHERE revoked_at IS NULL AND expires_at > now()
  LOOP
    IF jsonb_typeof(grant_row.resource_scope) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'active ops access grants use an incompatible scope; revoke and reissue before migration 163' USING ERRCODE = '22023';
    END IF;
    IF grant_row.workspace_id = '*' OR grant_row.workspace_id <> btrim(grant_row.workspace_id)
      OR length(grant_row.workspace_id) NOT BETWEEN 1 AND 255 OR grant_row.workspace_id ~ '[[:cntrl:]]'
      OR grant_row.resource_scope->'workspace_ids' IS DISTINCT FROM jsonb_build_array(grant_row.workspace_id)
      OR EXISTS (
        SELECT 1 FROM jsonb_each(grant_row.resource_scope) AS entry(key, value)
        WHERE entry.key <> 'workspace_ids' AND (
          entry.key IN ('type', 'ids') OR right(entry.key, 4) = '_ids'
          OR entry.key <> btrim(entry.key) OR length(entry.key) NOT BETWEEN 1 AND 255 OR entry.key ~ '[[:cntrl:]]'
          OR jsonb_typeof(entry.value) IS DISTINCT FROM 'string'
          OR entry.value #>> '{}' <> btrim(entry.value #>> '{}')
          OR length(entry.value #>> '{}') NOT BETWEEN 1 AND 255 OR entry.value #>> '{}' ~ '[[:cntrl:]]'
        )
      ) THEN
      RAISE EXCEPTION 'active ops access grants use an incompatible scope; revoke and reissue before migration 163' USING ERRCODE = '22023';
    END IF;
  END LOOP;
END
$authorization_workspace_scope_audit$;

CREATE OR REPLACE FUNCTION validate_ops_access_grant_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.resource_scope) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ops access grant scope is invalid' USING ERRCODE = '22023';
  END IF;
  IF NEW.workspace_id = '*' OR NEW.workspace_id <> btrim(NEW.workspace_id)
    OR length(NEW.workspace_id) NOT BETWEEN 1 AND 255 OR NEW.workspace_id ~ '[[:cntrl:]]'
    OR NEW.resource_scope->'workspace_ids' IS DISTINCT FROM jsonb_build_array(NEW.workspace_id)
    OR EXISTS (
      SELECT 1 FROM jsonb_each(NEW.resource_scope) AS entry(key, value)
      WHERE entry.key <> 'workspace_ids' AND (
        entry.key IN ('type', 'ids') OR right(entry.key, 4) = '_ids'
        OR entry.key <> btrim(entry.key) OR length(entry.key) NOT BETWEEN 1 AND 255 OR entry.key ~ '[[:cntrl:]]'
        OR jsonb_typeof(entry.value) IS DISTINCT FROM 'string'
        OR entry.value #>> '{}' <> btrim(entry.value #>> '{}')
        OR length(entry.value #>> '{}') NOT BETWEEN 1 AND 255 OR entry.value #>> '{}' ~ '[[:cntrl:]]'
      )
    ) THEN
    RAISE EXCEPTION 'ops access grant scope is invalid' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ops_access_grants_scope_integrity ON ops_access_grants;
CREATE TRIGGER ops_access_grants_scope_integrity
BEFORE INSERT OR UPDATE OF workspace_id, resource_scope ON ops_access_grants
FOR EACH ROW EXECUTE FUNCTION validate_ops_access_grant_scope();
