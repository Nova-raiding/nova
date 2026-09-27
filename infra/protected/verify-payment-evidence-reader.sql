-- REVIEW_ONLY. Run through verify-payment-evidence-reader.sh as the dedicated
-- login. This query returns only a verdict; it never emits payment rows.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT set_config('app.workspace_id', '__payment_evidence_reader_probe__', true) \gset
WITH reader AS (
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
         rolbypassrls, rolreplication, rolcanlogin, rolconnlimit
  FROM pg_roles WHERE rolname = current_user
), expected_columns(relation_name, column_name) AS (
  VALUES
    ('public.billing_orders', 'id'),
    ('public.billing_orders', 'workspace_id'),
    ('public.billing_orders', 'state'),
    ('public.billing_orders', 'payment_mode'),
    ('public.billing_orders', 'channel'),
    ('public.billing_orders', 'amount_fen'),
    ('public.billing_orders', 'provider_trade_id'),
    ('public.billing_transactions', 'id'),
    ('public.billing_transactions', 'workspace_id'),
    ('public.billing_transactions', 'order_id'),
    ('public.billing_transactions', 'type'),
    ('public.billing_transactions', 'amount_fen')
), sources AS (
  SELECT c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c WHERE c.oid IN
    ('public.billing_orders'::regclass, 'public.billing_transactions'::regclass)
), source_acl AS (
  SELECT count(*) = 2 AND bool_and(relrowsecurity AND relforcerowsecurity
         AND relowner <> (SELECT oid FROM reader)
         AND NOT has_table_privilege(current_user, oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         AND NOT has_any_column_privilege(current_user, oid, 'INSERT,UPDATE,REFERENCES')) AS exact_sources
  FROM sources
), column_acl AS (
  SELECT count(*) = 12 AND bool_and(has_column_privilege(
           current_user, relation_name, column_name, 'SELECT')) AS required_select
  FROM expected_columns
), extra_columns AS (
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN sources s ON s.oid = a.attrelid
    WHERE a.attnum > 0 AND NOT a.attisdropped
      AND NOT EXISTS (SELECT 1 FROM expected_columns e
        WHERE e.relation_name = 'public.' || s.relname AND e.column_name = a.attname)
      AND has_column_privilege(current_user, s.oid, a.attname, 'SELECT,INSERT,UPDATE,REFERENCES')
  ) AS none
), policies AS (
  SELECT count(*) = 2 AND bool_and(
    (SELECT count(*) = 1 AND bool_and(
       p.polname = s.relname || '_workspace_isolation'
       AND p.polpermissive AND p.polcmd = '*' AND p.polroles = ARRAY[0]::oid[]
       AND pg_get_expr(p.polqual, p.polrelid) =
         '(workspace_id = current_setting(''app.workspace_id''::text, true))'
     ) FROM pg_policy p WHERE p.polrelid = s.oid AND p.polcmd IN ('r', '*')
       AND (0 = ANY(p.polroles) OR (SELECT oid FROM reader) = ANY(p.polroles))
    )
  ) AS exact_workspace_select
  FROM sources s
), outside_access AS (
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND c.oid NOT IN (SELECT oid FROM sources)
      AND (has_table_privilege(current_user, c.oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND c.relkind = 'S'
      AND has_sequence_privilege(current_user, c.oid, 'USAGE,SELECT,UPDATE')
  ) AS none
), other_capabilities AS (
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_auth_members m, reader r WHERE m.member = r.oid OR m.roleid = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class c, reader r WHERE c.relowner = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p, reader r WHERE p.proowner = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_namespace n, reader r WHERE n.nspowner = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_database d, reader r WHERE d.datdba = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_type t, reader r WHERE t.typowner = r.oid
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND p.prosecdef AND p.prorettype <> 'pg_catalog.trigger'::regtype
      AND has_function_privilege(current_user, p.oid, 'EXECUTE')
  ) AS none
), database_acl AS (
  SELECT has_database_privilege(current_user, current_database(), 'CONNECT')
      AND NOT has_database_privilege(current_user, current_database(), 'CREATE,TEMPORARY')
      AND NOT EXISTS (
        SELECT 1 FROM pg_database d WHERE d.datname <> current_database()
          AND d.datallowconn AND has_database_privilege(current_user, d.oid, 'CONNECT,CREATE,TEMPORARY')
      ) AS minimal
), schema_acl AS (
  SELECT has_schema_privilege(current_user, 'public', 'USAGE')
      AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('public', 'information_schema')
          AND left(n.nspname, 3) <> 'pg_'
          AND has_schema_privilege(current_user, n.oid, 'USAGE,CREATE')
      ) AS minimal
), read_probe AS MATERIALIZED (
  SELECT (SELECT count(*) FROM (
    SELECT id, workspace_id, state, payment_mode, channel, amount_fen, provider_trade_id
    FROM public.billing_orders LIMIT 1
  ) q) + (SELECT count(*) FROM (
    SELECT id, workspace_id, order_id, type, amount_fen
    FROM public.billing_transactions LIMIT 1
  ) q) AS rows_seen
)
SELECT CASE WHEN current_user = 'payment_evidence_reader'
  AND session_user = 'payment_evidence_reader'
  AND current_setting('transaction_read_only') = 'on'
  AND current_setting('row_security') = 'on'
  AND EXISTS (SELECT 1 FROM reader WHERE NOT rolsuper AND NOT rolcreatedb
    AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls
    AND NOT rolreplication AND rolcanlogin AND rolconnlimit = 2)
  AND (SELECT exact_sources FROM source_acl)
  AND (SELECT required_select FROM column_acl)
  AND (SELECT none FROM extra_columns)
  AND (SELECT exact_workspace_select FROM policies)
  AND (SELECT none FROM outside_access)
  AND (SELECT none FROM other_capabilities)
  AND (SELECT minimal FROM database_acl)
  AND (SELECT minimal FROM schema_acl)
  AND (SELECT rows_seen BETWEEN 0 AND 2 FROM read_probe)
  THEN 'payment-evidence-reader:ok'
  ELSE 'payment-evidence-reader:fail'
END;
ROLLBACK;
