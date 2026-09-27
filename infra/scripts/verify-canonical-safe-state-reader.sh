#!/bin/sh
set -eu

command -v psql >/dev/null 2>&1 || { echo 'psql is required to verify the canonical safe-state reader' >&2; exit 1; }
: "${CANONICAL_SAFE_STATE_PGSERVICE:?CANONICAL_SAFE_STATE_PGSERVICE is required}"
: "${PGSERVICEFILE:?PGSERVICEFILE must point to the protected libpq service file}"
printf '%s' "$CANONICAL_SAFE_STATE_PGSERVICE" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' || {
  echo 'CANONICAL_SAFE_STATE_PGSERVICE must be a simple service name' >&2
  exit 1
}
case "$PGSERVICEFILE" in /*) ;; *) echo 'PGSERVICEFILE must be an absolute protected path' >&2; exit 1 ;; esac
service_file_real=$(realpath "$PGSERVICEFILE")
[ "$service_file_real" = "$PGSERVICEFILE" ] && [ -f "$service_file_real" ] && [ ! -L "$service_file_real" ] || {
  echo 'PGSERVICEFILE must be a canonical regular file' >&2
  exit 1
}
service_file_mode=$(stat -c '%a' "$service_file_real" 2>/dev/null || stat -f '%Lp' "$service_file_real")
[ "$service_file_mode" = 600 ] || { echo 'PGSERVICEFILE must have mode 0600' >&2; exit 1; }
service_file_uid=$(stat -c '%u' "$service_file_real" 2>/dev/null || stat -f '%u' "$service_file_real")
[ "$service_file_uid" = "$(id -u)" ] || { echo 'PGSERVICEFILE must be owned by the current user' >&2; exit 1; }

# One read-only transaction verifies role identity, role attributes, absence
# of memberships/ownership, forced RLS, exact SELECT policy, effective ACLs,
# and executable reads on all three source tables. No writes are attempted.
result=$(psql "service=$CANONICAL_SAFE_STATE_PGSERVICE" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH reader AS (
  SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
         rolbypassrls, rolreplication, rolcanlogin, rolconnlimit
  FROM pg_roles WHERE rolname = current_user
), source_tables AS (
  SELECT unnest(ARRAY[
    'public.workspaces',
    'public.platform_feature_flags',
    'public.platform_feature_flag_targets'
  ]) AS relation_name
), source_acl AS (
  SELECT bool_and(to_regclass(relation_name) IS NOT NULL) AS all_tables_exist,
         bool_and(has_table_privilege(current_user, relation_name, 'SELECT')) AS all_select,
         bool_and(NOT has_table_privilege(current_user, relation_name,
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
           AND bool_and(NOT has_any_column_privilege(current_user, relation_name,
             'INSERT,UPDATE,REFERENCES')) AS no_table_or_column_writes,
         bool_and((SELECT c.relowner <> (SELECT oid FROM reader)
                   FROM pg_class c WHERE c.oid = to_regclass(relation_name))) AS no_owned_tables
  FROM source_tables
), membership AS (
  SELECT count(*) = 0 AS no_memberships
  FROM pg_auth_members m, reader r
  WHERE m.member = r.oid OR m.roleid = r.oid
), workspace_policy AS (
  SELECT c.relrowsecurity AND c.relforcerowsecurity AS forced_rls,
         (SELECT count(*) = 1 AND bool_and(
            p.polname = 'workspaces_canonical_safe_state_reader'
            AND p.polcmd = 'r'
            AND p.polpermissive
            AND p.polroles = ARRAY[(SELECT oid FROM reader)]::oid[]
            AND pg_get_expr(p.polqual, p.polrelid) =
                '(CURRENT_USER = ''canonical_safe_state_reader''::name)'
          ) FROM pg_policy p WHERE p.polrelid = c.oid
            AND p.polname = 'workspaces_canonical_safe_state_reader') AS exact_reader_policy,
         NOT EXISTS (
           SELECT 1 FROM pg_policy p, reader r
           WHERE p.polrelid = c.oid AND NOT p.polpermissive
             AND p.polcmd IN ('r', '*')
             AND (0::oid = ANY(p.polroles) OR r.oid = ANY(p.polroles))
         ) AS no_restrictive_reader_policy
  FROM pg_class c WHERE c.oid = 'public.workspaces'::regclass
), schema_acl AS (
  SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
         NOT has_database_privilege(current_user, current_database(), 'CREATE,TEMPORARY') AS no_database_create_or_temp,
         has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public,
         NOT has_schema_privilege(current_user, 'public', 'CREATE') AS no_public_create,
         NOT EXISTS (
           SELECT 1 FROM pg_namespace n
           WHERE n.nspname <> 'public' AND n.nspname <> 'information_schema'
             AND left(n.nspname, 3) <> 'pg_'
             AND has_schema_privilege(current_user, n.oid, 'USAGE,CREATE')
         ) AS no_other_schema_access
), other_relations AS (
  SELECT NOT EXISTS (
    SELECT 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND c.oid NOT IN (
        'public.workspaces'::regclass,
        'public.platform_feature_flags'::regclass,
        'public.platform_feature_flag_targets'::regclass
      )
      AND (has_table_privilege(current_user, c.oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(current_user, c.oid,
             'SELECT,INSERT,UPDATE,REFERENCES'))
  ) AS no_other_relation_access,
  NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND c.relkind = 'S'
      AND has_sequence_privilege(current_user, c.oid, 'USAGE,SELECT,UPDATE')
  ) AS no_sequence_access
), other_capabilities AS (
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND p.prosecdef AND p.prorettype <> 'pg_catalog.trigger'::regtype
      AND has_function_privilege(current_user, p.oid, 'EXECUTE')
  ) AS no_security_definer_execution,
  NOT EXISTS (
    SELECT 1 FROM pg_class c, reader r WHERE c.relowner = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p, reader r WHERE p.proowner = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_namespace n, reader r WHERE n.nspowner = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_database d, reader r WHERE d.datdba = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_type t, reader r WHERE t.typowner = r.oid
  ) AS no_owned_objects,
  NOT EXISTS (
    SELECT 1 FROM pg_database d
    WHERE d.datname <> current_database() AND d.datallowconn
      AND has_database_privilege(current_user, d.oid, 'CONNECT,CREATE,TEMPORARY')
  ) AS no_other_database_access
), source_rls AS (
  SELECT bool_and(NOT c.relrowsecurity) AS flags_unfiltered
  FROM pg_class c
  WHERE c.oid IN ('public.platform_feature_flags'::regclass,
                  'public.platform_feature_flag_targets'::regclass)
), read_probe AS MATERIALIZED (
  SELECT (SELECT count(*) FROM (SELECT 1 FROM public.workspaces LIMIT 1) AS w)
       + (SELECT count(*) FROM (SELECT 1 FROM public.platform_feature_flags LIMIT 1) AS f)
       + (SELECT count(*) FROM (SELECT 1 FROM public.platform_feature_flag_targets LIMIT 1) AS t)
       AS readable_rows
)
SELECT CASE WHEN
  current_user = 'canonical_safe_state_reader'
  AND session_user = 'canonical_safe_state_reader'
  AND current_setting('transaction_read_only') = 'on'
  AND current_setting('row_security') = 'on'
  AND EXISTS (SELECT 1 FROM reader WHERE NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls
      AND NOT rolreplication AND rolcanlogin AND rolconnlimit = 2)
  AND (SELECT all_tables_exist AND all_select AND no_table_or_column_writes AND no_owned_tables FROM source_acl)
  AND (SELECT no_memberships FROM membership)
  AND (SELECT forced_rls AND exact_reader_policy AND no_restrictive_reader_policy FROM workspace_policy)
  AND (SELECT can_connect AND no_database_create_or_temp AND can_use_public
      AND no_public_create AND no_other_schema_access FROM schema_acl)
  AND (SELECT no_other_relation_access AND no_sequence_access FROM other_relations)
  AND (SELECT no_security_definer_execution AND no_owned_objects
      AND no_other_database_access FROM other_capabilities)
  AND (SELECT flags_unfiltered FROM source_rls)
  AND (SELECT readable_rows BETWEEN 0 AND 3 FROM read_probe)
  THEN 'canonical-safe-state-reader:ok'
  ELSE 'canonical-safe-state-reader:fail'
END;
ROLLBACK;
SQL
)

[ "$result" = 'canonical-safe-state-reader:ok' ] || {
  echo 'canonical safe-state reader role/ACL/RLS verification failed; no evidence was produced' >&2
  exit 1
}
echo 'canonical safe-state reader role/ACL/RLS verified (review-only; no production evidence produced)'
