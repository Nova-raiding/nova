#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
command -v psql >/dev/null 2>&1 || { echo 'psql is required to verify the runtime database role' >&2; exit 1; }

alert_receiver_database_url=${ALERT_RECEIVER_DATABASE_URL:-}
alert_receiver_database_url_file=${ALERT_RECEIVER_DATABASE_URL_FILE:-}
if [ -n "$alert_receiver_database_url" ] && [ -n "$alert_receiver_database_url_file" ]; then
  echo 'Set only one of ALERT_RECEIVER_DATABASE_URL or ALERT_RECEIVER_DATABASE_URL_FILE' >&2
  exit 1
fi
if [ -n "$alert_receiver_database_url_file" ]; then
  [ -f "$alert_receiver_database_url_file" ] && [ ! -L "$alert_receiver_database_url_file" ] && [ -r "$alert_receiver_database_url_file" ] || {
    echo 'ALERT_RECEIVER_DATABASE_URL_FILE must be a readable regular non-symbolic-link file' >&2
    exit 1
  }
  alert_receiver_database_url=$(sed -n '1p' "$alert_receiver_database_url_file")
fi
[ -n "$alert_receiver_database_url" ] || {
  echo 'ALERT_RECEIVER_DATABASE_URL or ALERT_RECEIVER_DATABASE_URL_FILE is required' >&2
  exit 1
}

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
     FROM unnest(ARRAY['platform_feature_flags','platform_feature_flag_targets','platform_feature_flag_events','platform_authorization_audit','authorization_revisions','authorization_execution_reservations','platform_role_assignments','platform_role_assignment_events','ops_access_grants','ops_access_grant_events']) AS name
    WHERE has_table_privilege(current_user, 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')")
[ -z "$platform_acl_exposure" ] || { echo "tenant runtime role can access platform control-plane tables: $platform_acl_exposure" >&2; exit 1; }

alert_receipt_runtime_exposure=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT CASE WHEN to_regclass('public.alert_webhook_receipts') IS NOT NULL
                    AND has_table_privilege(current_user, 'public.alert_webhook_receipts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               THEN 'alert_webhook_receipts' ELSE '' END")
[ -z "$alert_receipt_runtime_exposure" ] || { echo 'tenant runtime role must not access alert webhook receipts' >&2; exit 1; }

ops_directory_exposure=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT CASE WHEN has_table_privilege(current_user, 'public.ops_workspace_summaries', 'SELECT') THEN 'ops_workspace_summaries' ELSE '' END")
[ -z "$ops_directory_exposure" ] || { echo 'tenant runtime role must not access the platform workspace directory projection' >&2; exit 1; }

model_budget_delete_exposure=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT CASE WHEN has_table_privilege(current_user, 'public.model_cost_budget_reservations', 'DELETE,TRUNCATE') THEN 'model_cost_budget_reservations' ELSE '' END")
[ -z "$model_budget_delete_exposure" ] || { echo 'tenant runtime role must not delete or truncate model cost budget reservations' >&2; exit 1; }

ticket_delete_exposure=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT CASE WHEN to_regclass('public.interactive_confirmation_tickets') IS NOT NULL
                    AND has_table_privilege(current_user, 'public.interactive_confirmation_tickets', 'DELETE,TRUNCATE')
              THEN 'interactive_confirmation_tickets' ELSE '' END")
[ -z "$ticket_delete_exposure" ] || { echo 'tenant runtime role must not delete or truncate interactive confirmation tickets' >&2; exit 1; }

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
        AND c.relname NOT IN ('commercial_rollouts', 'workspace_members', 'workspace_identity_bindings', 'workspace_commercial_settings', 'workspace_subscriptions', 'ops_access_grants', 'ops_access_grant_events', 'authorization_execution_reservations', 'mcp_oauth_authorization_codes', 'mcp_oauth_tokens')
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

mcp_oauth_rls_failures=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
  "WITH expected(tablename, policyname, qual, with_check) AS (
     VALUES
       ('mcp_oauth_authorization_codes', 'mcp_oauth_authorization_codes_workspace_isolation', '(workspace_id = current_setting(''app.workspace_id''::text, true))', '(workspace_id = current_setting(''app.workspace_id''::text, true))'),
       ('mcp_oauth_tokens', 'mcp_oauth_tokens_workspace_isolation', '(workspace_id = current_setting(''app.workspace_id''::text, true))', '(workspace_id = current_setting(''app.workspace_id''::text, true))'),
       ('mcp_oauth_authorization_codes', 'mcp_oauth_authorization_codes_ops', '((CURRENT_USER = ''merchant_ops''::name) AND (current_setting(''app.platform_scope''::text, true) = ''platform_ops''::text))', '((CURRENT_USER = ''merchant_ops''::name) AND (current_setting(''app.platform_scope''::text, true) = ''platform_ops''::text))'),
       ('mcp_oauth_tokens', 'mcp_oauth_tokens_ops', '((CURRENT_USER = ''merchant_ops''::name) AND (current_setting(''app.platform_scope''::text, true) = ''platform_ops''::text))', '((CURRENT_USER = ''merchant_ops''::name) AND (current_setting(''app.platform_scope''::text, true) = ''platform_ops''::text))')
   ), actual AS (
     SELECT tablename, policyname, cmd, permissive, roles, qual, with_check
       FROM pg_policies WHERE schemaname = 'public'
         AND tablename IN ('mcp_oauth_authorization_codes', 'mcp_oauth_tokens')
   )
   SELECT coalesce(string_agg(coalesce(e.tablename, a.tablename) || '.' || coalesce(e.policyname, a.policyname), ',' ORDER BY coalesce(e.tablename, a.tablename), coalesce(e.policyname, a.policyname)), '')
     FROM expected e FULL JOIN actual a USING (tablename, policyname)
     LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || coalesce(e.tablename, a.tablename))
    WHERE e.policyname IS NULL OR a.policyname IS NULL
       OR c.oid IS NULL OR c.relkind NOT IN ('r','p') OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
       OR a.cmd IS DISTINCT FROM 'ALL' OR a.permissive <> 'PERMISSIVE' OR a.roles <> ARRAY['public']::name[]
       OR replace(a.qual, ' ', '') IS DISTINCT FROM replace(e.qual, ' ', '')
       OR replace(a.with_check, ' ', '') IS DISTINCT FROM replace(e.with_check, ' ', '')")
[ -z "$mcp_oauth_rls_failures" ] || { echo "MCP OAuth tables missing workspace/platform RLS policies: $mcp_oauth_rls_failures" >&2; exit 1; }

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

  delivery_acl_failures=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(string_agg(name, ','), '')
       FROM unnest(ARRAY['workspace_customer_deliveries','workspace_customer_delivery_checklist_items','workspace_customer_delivery_videos']) AS name
      WHERE has_table_privilege('$runtime_role', 'public.' || name, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
         OR NOT has_table_privilege(current_user, 'public.' || name, 'SELECT')
         OR NOT has_table_privilege(current_user, 'public.' || name, 'INSERT')
         OR (name <> 'workspace_customer_delivery_videos' AND NOT has_table_privilege(current_user, 'public.' || name, 'UPDATE'))
         OR has_table_privilege(current_user, 'public.' || name, 'DELETE,TRUNCATE,REFERENCES,TRIGGER')")
  [ -z "$delivery_acl_failures" ] || { echo "Customer delivery control-plane ACL mismatch: $delivery_acl_failures" >&2; exit 1; }
  delivery_audit_access=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT has_table_privilege(current_user, 'public.workspace_operation_audit', 'INSERT')
        AND NOT has_table_privilege(current_user, 'public.workspace_operation_audit', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND has_column_privilege(current_user, 'public.workspace_customer_delivery_videos', 'deleted_at', 'UPDATE')")
  [ "$delivery_audit_access" = t ] || { echo 'Customer delivery audit must be append-only and video removal must remain soft-delete' >&2; exit 1; }

  ops_missing_reservation_access=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT CASE WHEN has_table_privilege(current_user, 'public.authorization_execution_reservations', 'SELECT,INSERT') THEN '' ELSE 'authorization_execution_reservations' END")
  [ -z "$ops_missing_reservation_access" ] || { echo "Ops database role lacks authorization reservation access: $ops_missing_reservation_access" >&2; exit 1; }

  ops_reservation_write_exposure=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT CASE WHEN has_table_privilege(current_user, 'public.authorization_execution_reservations', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN 'authorization_execution_reservations' ELSE '' END")
  [ -z "$ops_reservation_write_exposure" ] || { echo "Ops database role has destructive authorization reservation access: $ops_reservation_write_exposure" >&2; exit 1; }

  ops_missing_platform_audit_access=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT CASE WHEN has_table_privilege(current_user, 'public.platform_authorization_audit', 'SELECT,INSERT') THEN '' ELSE 'platform_authorization_audit' END")
  [ -z "$ops_missing_platform_audit_access" ] || { echo "Ops database role lacks append-only platform authorization audit access: $ops_missing_platform_audit_access" >&2; exit 1; }

  ops_platform_audit_write_exposure=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT CASE WHEN has_table_privilege(current_user, 'public.platform_authorization_audit', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN 'platform_authorization_audit' ELSE '' END")
  [ -z "$ops_platform_audit_write_exposure" ] || { echo "Ops database role has destructive platform authorization audit access: $ops_platform_audit_write_exposure" >&2; exit 1; }

  ops_tenant_access=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND c.relname NOT IN ('platform_feature_flags','platform_feature_flag_targets','platform_feature_flag_events','platform_identities','platform_auth_sessions','platform_identity_events','platform_password_accounts','platform_password_sessions','platform_password_reset_tokens','platform_media_specs','platform_media_spec_audit','platform_authorization_audit','public_platform_rule_versions','public_platform_rule_audits','authorization_revisions','authorization_execution_reservations','platform_role_assignments','platform_role_assignment_events','ops_access_grants','ops_access_grant_events','workspace_customer_deliveries','workspace_customer_delivery_videos','workspace_customer_delivery_checklist_items','manual_publish_evidence','mcp_oauth_authorization_codes','mcp_oauth_tokens','commercial_offers','commercial_addons','commercial_coupons','commercial_rollouts','model_markup_policy','commercial_catalog_skus','commercial_catalog_sku_versions','commercial_catalog_sku_benefits','commercial_catalog_events_v2')
        AND NOT (c.relname = 'workspace_operation_audit' AND NOT has_table_privilege(current_user, c.oid, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))")
  [ -z "$ops_tenant_access" ] || { echo "Ops database role has unexpected tenant write access: $ops_tenant_access" >&2; exit 1; }
  ops_alert_receipt_exposure=$(psql "$OPS_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
    "SELECT CASE WHEN has_table_privilege(current_user, 'public.alert_webhook_receipts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 THEN 'alert_webhook_receipts' ELSE '' END")
  [ -z "$ops_alert_receipt_exposure" ] || { echo 'Ops database role must not access alert webhook receipts' >&2; exit 1; }
  echo "Ops database role verified: role=$ops_role control_plane=allowed tenant_reads=bounded tenant_writes=denied"
fi

alert_receiver_state=$(psql "$alert_receiver_database_url" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT current_user || '|' || session_user || '|' || r.rolsuper || '|' || r.rolbypassrls || '|' || r.rolinherit || '|' ||
          r.rolcreatedb || '|' || r.rolcreaterole || '|' || r.rolreplication || '|' ||
          (SELECT count(*) FROM pg_auth_members membership WHERE membership.member = r.oid) || '|' ||
          (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p') AND n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user)
     FROM pg_roles r WHERE r.rolname = current_user")
IFS='|' read -r alert_receiver_role alert_receiver_session_role alert_receiver_super alert_receiver_bypass alert_receiver_inherit alert_receiver_createdb alert_receiver_createrole alert_receiver_replication alert_receiver_memberships alert_receiver_owned_tables <<EOF
$alert_receiver_state
EOF
[ "$alert_receiver_role" = merchant_alert_receiver ] || { echo 'Alert receiver database role must be merchant_alert_receiver' >&2; exit 1; }
[ "$alert_receiver_session_role" = "$alert_receiver_role" ] || { echo 'Alert receiver session role must not use SET ROLE impersonation' >&2; exit 1; }
[ "$alert_receiver_role" != "$runtime_role" ] || { echo 'Alert receiver and tenant runtime database roles must be distinct' >&2; exit 1; }
if [ -n "${ops_role:-}" ]; then
  [ "$alert_receiver_role" != "$ops_role" ] || { echo 'Alert receiver and Ops database roles must be distinct' >&2; exit 1; }
fi
case "$alert_receiver_super" in f|false) ;; *) echo 'Alert receiver database role must not be a superuser' >&2; exit 1 ;; esac
case "$alert_receiver_bypass" in f|false) ;; *) echo 'Alert receiver database role must not bypass RLS' >&2; exit 1 ;; esac
case "$alert_receiver_inherit" in f|false) ;; *) echo 'Alert receiver database role must be NOINHERIT' >&2; exit 1 ;; esac
case "$alert_receiver_createdb" in f|false) ;; *) echo 'Alert receiver database role must not create databases' >&2; exit 1 ;; esac
case "$alert_receiver_createrole" in f|false) ;; *) echo 'Alert receiver database role must not create roles' >&2; exit 1 ;; esac
case "$alert_receiver_replication" in f|false) ;; *) echo 'Alert receiver database role must not have replication privileges' >&2; exit 1 ;; esac
[ "$alert_receiver_memberships" = 0 ] || { echo 'Alert receiver database role must not be a member of another role' >&2; exit 1; }
[ "$alert_receiver_owned_tables" = 0 ] || { echo 'Alert receiver database role must not own public application tables' >&2; exit 1; }

alert_receiver_table_exposure=$(psql "$alert_receiver_database_url" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')")
[ -z "$alert_receiver_table_exposure" ] || { echo "Alert receiver database role has direct application table access: $alert_receiver_table_exposure" >&2; exit 1; }

alert_receiver_missing_functions=$(psql "$alert_receiver_database_url" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(signature, ',' ORDER BY signature), '')
     FROM unnest(ARRAY[
       'public.append_alert_webhook_receipt(text,text,timestamp with time zone,timestamp with time zone,text,jsonb)',
       'public.alert_webhook_receipts_ready()'
     ]) AS signature
    WHERE to_regprocedure(signature) IS NULL OR NOT has_function_privilege(current_user, signature, 'EXECUTE')")
[ -z "$alert_receiver_missing_functions" ] || { echo "Alert receiver database role lacks required function access: $alert_receiver_missing_functions" >&2; exit 1; }

# Explicit grants to the receiver role must be limited to the two narrow
# SECURITY DEFINER entry points. PUBLIC/extension functions are not counted as
# receiver grants here and cannot grant direct application-table access.
alert_receiver_unexpected_function_grants=$(psql "$alert_receiver_database_url" -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text), '')
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
     JOIN pg_roles granted_role ON granted_role.oid = acl.grantee
    WHERE n.nspname = 'public' AND granted_role.rolname = current_user AND acl.privilege_type = 'EXECUTE'
      AND p.oid NOT IN (
        'public.append_alert_webhook_receipt(text,text,timestamp with time zone,timestamp with time zone,text,jsonb)'::regprocedure,
        'public.alert_webhook_receipts_ready()'::regprocedure
      )")
[ -z "$alert_receiver_unexpected_function_grants" ] || { echo "Alert receiver database role has unexpected explicit function grants: $alert_receiver_unexpected_function_grants" >&2; exit 1; }

alert_probe_suffix="$$"
alert_probe_request_id="runtime-role-probe-$alert_probe_suffix"
alert_probe_alert_id="runtime-alert-probe-$alert_probe_suffix"
if ! psql "$alert_receiver_database_url" -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
BEGIN;
DO \$probe\$
DECLARE
  inserted boolean;
BEGIN
  IF NOT public.alert_webhook_receipts_ready() THEN
    RAISE EXCEPTION 'alert receipt readiness function returned false';
  END IF;
  inserted := public.append_alert_webhook_receipt(
    '$alert_probe_alert_id', '$alert_probe_request_id',
    '2026-09-14T08:00:00Z'::timestamptz, '2026-09-14T07:59:00Z'::timestamptz,
    repeat('a', 64),
    jsonb_build_object('request_id', '$alert_probe_request_id', 'alert', jsonb_build_object('id', '$alert_probe_alert_id'))
  );
  IF inserted IS DISTINCT FROM true THEN RAISE EXCEPTION 'first alert receipt append was not accepted'; END IF;
  inserted := public.append_alert_webhook_receipt(
    '$alert_probe_alert_id', '$alert_probe_request_id',
    '2026-09-14T08:00:00Z'::timestamptz, '2026-09-14T07:59:00Z'::timestamptz,
    repeat('a', 64),
    jsonb_build_object('request_id', '$alert_probe_request_id', 'alert', jsonb_build_object('id', '$alert_probe_alert_id'))
  );
  IF inserted IS DISTINCT FROM false THEN RAISE EXCEPTION 'alert receipt replay was not rejected'; END IF;

  BEGIN
    PERFORM request_id FROM public.alert_webhook_receipts LIMIT 1;
    RAISE EXCEPTION 'direct alert receipt read was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.alert_webhook_receipts(request_id, alert_id, received_at, sent_at, body_sha256, payload)
    VALUES ('direct-$alert_probe_request_id', 'direct-$alert_probe_alert_id', now(), now(), repeat('b', 64),
      jsonb_build_object('request_id', 'direct-$alert_probe_request_id', 'alert', jsonb_build_object('id', 'direct-$alert_probe_alert_id')));
    RAISE EXCEPTION 'direct alert receipt insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
\$probe\$;
ROLLBACK;
SQL
then
  echo 'Alert receiver transactional function/ACL probe failed' >&2
  exit 1
fi

echo "Alert receiver database role verified: role=$alert_receiver_role table_access=denied function_access=append_and_ready"
