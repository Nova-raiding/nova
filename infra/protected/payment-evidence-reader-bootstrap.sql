-- REVIEW_ONLY: provision a dedicated payment ledger observer after owner review.
-- Run as a database administrator against the intended database. This changes
-- role/ACL metadata only; it never reads or changes payment rows and produces
-- no release evidence. Credentials are provisioned out of band.
BEGIN;

DO $preflight$
DECLARE source_table regclass;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payment_evidence_reader') THEN
    RAISE EXCEPTION 'payment_evidence_reader exists; audit it instead of reusing or replacing it';
  END IF;
  FOREACH source_table IN ARRAY ARRAY['public.billing_orders'::regclass,
                                     'public.billing_transactions'::regclass] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.oid = source_table
        AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'payment source % must have ENABLE and FORCE RLS', source_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = source_table
        AND p.polname = (SELECT c.relname || '_workspace_isolation' FROM pg_class c WHERE c.oid = source_table)
        AND p.polpermissive AND p.polcmd = '*' AND p.polroles = ARRAY[0]::oid[]
        AND pg_get_expr(p.polqual, p.polrelid) =
          '(workspace_id = current_setting(''app.workspace_id''::text, true))'
    ) OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid = source_table
           AND p.polcmd IN ('r', '*') AND 0 = ANY(p.polroles)) <> 1 THEN
      RAISE EXCEPTION 'payment source % has an unexpected applicable SELECT policy', source_table;
    END IF;
  END LOOP;
  -- TEMP and unrelated relation access inherited through PUBLIC cannot be
  -- revoked from one role. Refuse until the database owner reviews shared ACLs.
  IF EXISTS (
    SELECT 1 FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    WHERE d.datname = current_database() AND acl.grantee = 0
      AND acl.privilege_type = 'TEMPORARY'
  ) THEN
    RAISE EXCEPTION 'PUBLIC TEMPORARY privilege must be reviewed before reader bootstrap';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    WHERE d.datname <> current_database() AND d.datallowconn
      AND acl.grantee = 0 AND acl.privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')
  ) THEN
    RAISE EXCEPTION 'PUBLIC access to another database must be reviewed before reader bootstrap';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND c.relacl IS NOT NULL
      AND acl.grantee = 0 AND acl.privilege_type IN
        ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'USAGE')
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
      AND acl.grantee = 0 AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
  ) THEN
    RAISE EXCEPTION 'PUBLIC relation or column ACL must be reviewed before reader bootstrap';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND p.prosecdef AND p.prorettype <> 'pg_catalog.trigger'::regtype
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can execute a user security-definer function';
  END IF;
END
$preflight$;

CREATE ROLE payment_evidence_reader LOGIN PASSWORD NULL
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION
  CONNECTION LIMIT 2;
ALTER ROLE payment_evidence_reader SET default_transaction_read_only = on;
ALTER ROLE payment_evidence_reader SET row_security = on;
ALTER ROLE payment_evidence_reader SET search_path = pg_catalog, public;
DO $grant_connect$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO payment_evidence_reader', current_database());
END $grant_connect$;
GRANT USAGE ON SCHEMA public TO payment_evidence_reader;

-- Only the columns used by the review-only callback/reconciliation snapshots.
GRANT SELECT (id, workspace_id, state, payment_mode, channel, amount_fen, provider_trade_id)
  ON public.billing_orders TO payment_evidence_reader;
GRANT SELECT (id, workspace_id, order_id, type, amount_fen)
  ON public.billing_transactions TO payment_evidence_reader;
COMMENT ON ROLE payment_evidence_reader IS
  'Review-only payment ledger observer; no payment/refund execution or evidence-signing capability';
COMMIT;
