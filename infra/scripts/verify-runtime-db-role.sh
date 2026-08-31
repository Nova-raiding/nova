#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
command -v psql >/dev/null 2>&1 || { echo 'psql is required to verify the runtime database role' >&2; exit 1; }

role_state=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT current_user || '|' || rolsuper || '|' || rolbypassrls
     FROM pg_roles
    WHERE rolname = current_user")
IFS='|' read -r runtime_role runtime_super runtime_bypass <<EOF
$role_state
EOF
[ -n "$runtime_role" ] || { echo 'runtime database role could not be resolved' >&2; exit 1; }
case "$runtime_super" in f|false) ;; *) echo 'runtime database role must not be a superuser' >&2; exit 1 ;; esac
case "$runtime_bypass" in f|false) ;; *) echo 'runtime database role must not bypass RLS' >&2; exit 1 ;; esac

owned_tables=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*)
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p')
      AND n.nspname = 'public'
      AND pg_get_userbyid(c.relowner) = current_user")
[ "$owned_tables" = 0 ] || { echo 'runtime database role must not own public application tables' >&2; exit 1; }

platform_acl_exposure=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(name, ',' ORDER BY name), '')
     FROM unnest(ARRAY['platform_feature_flags','platform_feature_flag_targets','platform_feature_flag_events','authorization_revisions','platform_role_assignments','platform_role_assignment_events','ops_access_grants','ops_access_grant_events']) AS name
    WHERE has_table_privilege(current_user, 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')")
[ -z "$platform_acl_exposure" ] || { echo "tenant runtime role can access platform control-plane tables: $platform_acl_exposure" >&2; exit 1; }

ops_directory_exposure=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT CASE WHEN has_table_privilege(current_user, 'public.ops_workspace_summaries', 'SELECT') THEN 'ops_workspace_summaries' ELSE '' END")
[ -z "$ops_directory_exposure" ] || { echo 'tenant runtime role must not access the platform workspace directory projection' >&2; exit 1; }

# Catalog checks are non-vacuous even on a newly restored empty database. Every
# ordinary tenant table must force RLS and expose only workspace-scoped policies.
# workspaces and workspace_members have intentionally different command-specific
# policy shapes, so they are verified exactly below instead of being exempted.
# commercial_rollouts is platform-global: workspace_id is only a target selector.
rls_failures=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "WITH tenant_tables AS (
     SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
        AND a.attname = 'workspace_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND c.relname NOT IN ('commercial_rollouts', 'workspace_members', 'workspace_identity_bindings', 'workspace_commercial_settings', 'workspace_subscriptions', 'ops_access_grants', 'ops_access_grant_events')
   ), scoped_policies AS (
     SELECT schemaname, tablename, count(*) AS policy_count,
            bool_or(
              permissive <> 'PERMISSIVE' OR roles <> ARRAY['public']::name[] OR
              coalesce(qual, '') <> '(workspace_id = current_setting(''app.workspace_id''::text, true))' OR
              (with_check IS NOT NULL AND with_check <> '(workspace_id = current_setting(''app.workspace_id''::text, true))')
            ) AS unsafe_policy
       FROM pg_policies
      WHERE schemaname = 'public'
      GROUP BY schemaname, tablename
   )
   SELECT coalesce(string_agg(t.relname, ',' ORDER BY t.relname), '')
     FROM tenant_tables t
     LEFT JOIN scoped_policies p ON p.tablename = t.relname
    WHERE NOT t.relrowsecurity OR NOT t.relforcerowsecurity OR coalesce(p.policy_count, 0) = 0 OR coalesce(p.unsafe_policy, true)")
[ -z "$rls_failures" ] || { echo "tenant tables missing forced workspace RLS policy: $rls_failures" >&2; exit 1; }

# Backfill control and human-review tables are release-critical. Keep an
# explicit check so a partially applied migration cannot pass this gate merely
# because the tables are absent from the catalog query above.
backfill_rls_failures=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "WITH expected(name) AS (VALUES ('canonical_backfill_runs'), ('canonical_backfill_conflicts'))
   SELECT coalesce(string_agg(e.name, ',' ORDER BY e.name), '')
     FROM expected e
     LEFT JOIN pg_class c ON c.relname = e.name
     LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = e.name
    WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR p.policyname IS NULL
       OR p.qual <> '(workspace_id = current_setting(''app.workspace_id''::text, true))'
       OR p.with_check <> '(workspace_id = current_setting(''app.workspace_id''::text, true))'")
[ -z "$backfill_rls_failures" ] || { echo "canonical backfill tables missing forced workspace RLS policy: $backfill_rls_failures" >&2; exit 1; }

# These tables intentionally use policy shapes that differ from the ordinary
# workspace_id equality: identity bindings scope by issuer/subject, while
# platform operations may read commercial/subscription summaries. Verify
# their policy families separately instead of treating them as ordinary rows.
special_scoped_failures=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "WITH expected(tablename, policyname) AS (
     VALUES
       ('workspace_identity_bindings', 'workspace_identity_bindings_identity_scope'),
       ('workspace_commercial_settings', 'workspace_commercial_settings_select_scope'),
       ('workspace_commercial_settings', 'workspace_commercial_settings_insert_scope'),
       ('workspace_commercial_settings', 'workspace_commercial_settings_update_scope'),
       ('workspace_commercial_settings', 'workspace_commercial_settings_delete_scope'),
       ('workspace_subscriptions', 'workspace_subscriptions_select_scope'),
       ('workspace_subscriptions', 'workspace_subscriptions_insert_scope'),
       ('workspace_subscriptions', 'workspace_subscriptions_update_scope'),
       ('workspace_subscriptions', 'workspace_subscriptions_delete_scope')
   ), actual AS (
     SELECT tablename, policyname, permissive, roles, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('workspace_identity_bindings', 'workspace_commercial_settings', 'workspace_subscriptions')
   ), missing AS (
     SELECT e.tablename || '.' || e.policyname AS policy
       FROM expected e LEFT JOIN actual a USING (tablename, policyname)
      WHERE a.policyname IS NULL
   ), unsafe AS (
     SELECT a.tablename || '.' || a.policyname AS policy
       FROM actual a
      WHERE a.permissive <> 'PERMISSIVE'
         OR a.roles <> ARRAY['public']::name[]
         OR (a.tablename = 'workspace_identity_bindings' AND (coalesce(a.qual, '') NOT LIKE '%app.identity_issuer%' OR coalesce(a.qual, '') NOT LIKE '%app.identity_subject%'))
         OR (a.tablename IN ('workspace_commercial_settings', 'workspace_subscriptions') AND coalesce(a.with_check, '') LIKE '%platform_scope%')
   )
   SELECT coalesce(string_agg(policy, ',' ORDER BY policy), '') FROM (SELECT policy FROM missing UNION SELECT policy FROM unsafe) failures")
[ -z "$special_scoped_failures" ] || { echo "special tenant RLS policy mismatch: $special_scoped_failures" >&2; exit 1; }

special_policy_failures=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "WITH expected(tablename, policyname, cmd, qual, with_check) AS (
     VALUES
       ('workspaces', 'workspaces_workspace_isolation', 'ALL',
        '((id = current_setting(''app.workspace_id''::text, true)) OR ((CURRENT_USER = ''merchant_ops''::name) AND (current_setting(''app.platform_scope''::text, true) = ''platform_ops''::text)))',
        '(id = current_setting(''app.workspace_id''::text, true))'),
       ('workspace_members', 'workspace_members_select_scope', 'SELECT',
        '((workspace_id = current_setting(''app.workspace_id''::text, true)) OR ((CURRENT_USER = ''merchant_ops''::name) AND (current_setting(''app.platform_scope''::text, true) = ''platform_ops''::text)))', NULL),
       ('workspace_members', 'workspace_members_insert_scope', 'INSERT', NULL,
        '(workspace_id = current_setting(''app.workspace_id''::text, true))'),
       ('workspace_members', 'workspace_members_update_scope', 'UPDATE',
        '(workspace_id = current_setting(''app.workspace_id''::text, true))',
        '(workspace_id = current_setting(''app.workspace_id''::text, true))'),
       ('workspace_members', 'workspace_members_delete_scope', 'DELETE',
        '(workspace_id = current_setting(''app.workspace_id''::text, true))', NULL)
   ), actual AS (
     SELECT tablename, policyname, cmd, qual, with_check, permissive, roles
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('workspaces', 'workspace_members')
   ), mismatches AS (
     SELECT coalesce(e.tablename, a.tablename) || '.' || coalesce(e.policyname, a.policyname) AS policy
       FROM expected e
       FULL JOIN actual a USING (tablename, policyname)
      WHERE e.policyname IS NULL OR a.policyname IS NULL
         OR a.permissive <> 'PERMISSIVE' OR a.roles <> ARRAY['public']::name[]
         OR a.cmd IS DISTINCT FROM e.cmd
         OR replace(a.qual, ' ', '') IS DISTINCT FROM replace(e.qual, ' ', '')
         OR replace(a.with_check, ' ', '') IS DISTINCT FROM replace(e.with_check, ' ', '')
   )
   SELECT coalesce(string_agg(policy, ',' ORDER BY policy), '') FROM mismatches")
[ -z "$special_policy_failures" ] || { echo "workspaces/workspace_members RLS policy mismatch: $special_policy_failures" >&2; exit 1; }

special_rls_state=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(relname, ',' ORDER BY relname), '')
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('workspaces', 'workspace_members')
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)")
[ -z "$special_rls_state" ] || { echo "workspaces/workspace_members must force RLS: $special_rls_state" >&2; exit 1; }

# Exercise real rows under two transaction-local tenant scopes. The transaction
# is always rolled back, so the probe is repeatable and leaves no release data.
probe_suffix="$$"
probe_a="__runtime_role_probe_${probe_suffix}_a__"
probe_b="__runtime_role_probe_${probe_suffix}_b__"
if ! psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
SELECT set_config('app.platform_scope', '', true);
SELECT set_config('app.workspace_id', '$probe_a', true);
INSERT INTO public.workspaces (id, status) VALUES ('$probe_a', 'active');
INSERT INTO public.workspace_members
  (id, workspace_id, external_subject, display_name, role, status, invited_by)
VALUES
  (md5('$probe_a')::uuid, '$probe_a', 'runtime-probe-a', 'Runtime probe A', 'workspace_owner', 'active', 'runtime-role-probe');

SELECT set_config('app.workspace_id', '$probe_b', true);
INSERT INTO public.workspaces (id, status) VALUES ('$probe_b', 'active');
INSERT INTO public.workspace_members
  (id, workspace_id, external_subject, display_name, role, status, invited_by)
VALUES
  (md5('$probe_b')::uuid, '$probe_b', 'runtime-probe-b', 'Runtime probe B', 'workspace_owner', 'active', 'runtime-role-probe');

SELECT set_config('app.workspace_id', '$probe_a', true);
DO \$probe\$
DECLARE
  affected integer;
BEGIN
  IF (SELECT count(*) FROM public.workspaces WHERE id = '$probe_a') <> 1 THEN
    RAISE EXCEPTION 'own workspace is not visible';
  END IF;
  IF (SELECT count(*) FROM public.workspaces WHERE id = '$probe_b') <> 0 THEN
    RAISE EXCEPTION 'foreign workspace is visible';
  END IF;
  IF (SELECT count(*) FROM public.workspace_members WHERE workspace_id = '$probe_a') <> 1 THEN
    RAISE EXCEPTION 'own workspace member is not visible';
  END IF;
  IF (SELECT count(*) FROM public.workspace_members WHERE workspace_id = '$probe_b') <> 0 THEN
    RAISE EXCEPTION 'foreign workspace member is visible';
  END IF;

  UPDATE public.workspaces SET status = status WHERE id = '$probe_a';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'own workspace update was denied'; END IF;
  UPDATE public.workspace_members SET display_name = display_name WHERE workspace_id = '$probe_a';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'own workspace member update was denied'; END IF;

  UPDATE public.workspaces SET status = status WHERE id = '$probe_b';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'foreign workspace update was allowed'; END IF;
  DELETE FROM public.workspaces WHERE id = '$probe_b';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'foreign workspace delete was allowed'; END IF;
  UPDATE public.workspace_members SET display_name = display_name WHERE workspace_id = '$probe_b';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'foreign workspace member update was allowed'; END IF;
  DELETE FROM public.workspace_members WHERE workspace_id = '$probe_b';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'foreign workspace member delete was allowed'; END IF;

  BEGIN
    INSERT INTO public.workspaces (id, status) VALUES ('${probe_b}_foreign', 'active');
    RAISE EXCEPTION 'cross-workspace insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.workspace_members
      (id, workspace_id, external_subject, display_name, role, status, invited_by)
    VALUES
      (md5('${probe_b}_cross')::uuid, '$probe_b', 'runtime-probe-cross', 'Runtime probe cross', 'operator', 'active', 'runtime-role-probe');
    RAISE EXCEPTION 'cross-workspace member insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
\$probe\$;
ROLLBACK;
SQL
then
  echo 'runtime RLS dynamic probe failed' >&2
  exit 1
fi

echo "runtime database role verified: role=$runtime_role superuser=false bypassrls=false owned_tables=0 tenant_rls=forced"

if [ -n "${OPS_DATABASE_URL:-}" ]; then
  ops_state=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT current_user || '|' || rolsuper || '|' || rolbypassrls || '|' ||
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r','p') AND n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user)
       FROM pg_roles WHERE rolname = current_user")
  IFS='|' read -r ops_role ops_super ops_bypass ops_owned_tables <<EOF
$ops_state
EOF
  [ "$ops_role" != "$runtime_role" ] || { echo 'Ops and tenant runtime database roles must be distinct' >&2; exit 1; }
  case "$ops_super" in f|false) ;; *) echo 'Ops database role must not be a superuser' >&2; exit 1 ;; esac
  case "$ops_bypass" in f|false) ;; *) echo 'Ops database role must not bypass RLS' >&2; exit 1 ;; esac
  [ "$ops_owned_tables" = 0 ] || { echo 'Ops database role must not own public application tables' >&2; exit 1; }

  ops_missing_control_access=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(string_agg(name, ',' ORDER BY name), '')
       FROM unnest(ARRAY['platform_feature_flags','platform_feature_flag_targets','platform_feature_flag_events']) AS name
      WHERE NOT has_table_privilege(current_user, 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE')")
  [ -z "$ops_missing_control_access" ] || { echo "Ops database role lacks platform control-plane access: $ops_missing_control_access" >&2; exit 1; }

  ops_tenant_access=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND c.relname NOT IN ('platform_feature_flags','platform_feature_flag_targets','platform_feature_flag_events','platform_identities','platform_auth_sessions','platform_identity_events','platform_media_specs','platform_media_spec_audit','authorization_revisions','platform_role_assignments','platform_role_assignment_events','ops_access_grants','ops_access_grant_events')")
  [ -z "$ops_tenant_access" ] || { echo "Ops database role has unexpected tenant write access: $ops_tenant_access" >&2; exit 1; }
  echo "Ops database role verified: role=$ops_role control_plane=allowed tenant_reads=bounded tenant_writes=denied"
fi
