-- REVIEW-ONLY bootstrap for the canonical safe-state observer.
-- Run manually as the database owner after reviewing the installed collector
-- and the target environment. This does not produce or sign release evidence.
-- Credentials must be provisioned out of band (for example, client TLS certs).

BEGIN;

DO $bootstrap$
BEGIN
  IF to_regclass('public.workspaces') IS NULL
     OR to_regclass('public.platform_feature_flags') IS NULL
     OR to_regclass('public.platform_feature_flag_targets') IS NULL THEN
    RAISE EXCEPTION 'canonical safe-state source tables are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'public.workspaces'::regclass
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'workspaces must already have ENABLE and FORCE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid IN ('public.platform_feature_flags'::regclass,
                    'public.platform_feature_flag_targets'::regclass)
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'feature flag source tables must not hide rows through RLS';
  END IF;
  -- Database TEMP is inheritable from PUBLIC and cannot be denied to one
  -- member role. Do not silently revoke it globally; require the database
  -- owner to make that shared-ACL decision before creating this reader.
  IF EXISTS (
    SELECT 1
    FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    WHERE d.datname = current_database()
      AND acl.grantee = 0
      AND acl.privilege_type = 'TEMPORARY'
  ) THEN
    RAISE EXCEPTION 'PUBLIC has TEMPORARY on this database; database owner must review shared ACL before provisioning a strictly read-only observer';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_database d
    CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    WHERE d.datname <> current_database()
      AND d.datallowconn
      AND acl.grantee = 0
      AND acl.privilege_type = 'CONNECT'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can connect to another database in this cluster; database owner must review shared ACL before provisioning an isolated observer';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE c.oid IN ('public.workspaces'::regclass,
                    'public.platform_feature_flags'::regclass,
                    'public.platform_feature_flag_targets'::regclass)
      AND c.relacl IS NOT NULL
      AND acl.grantee = 0
      AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) OR EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE c.oid IN ('public.workspaces'::regclass,
                    'public.platform_feature_flags'::regclass,
                    'public.platform_feature_flag_targets'::regclass)
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attacl IS NOT NULL
      AND acl.grantee = 0
      AND acl.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  ) THEN
    RAISE EXCEPTION 'PUBLIC has write privileges on a canonical safe-state source; database owner must review table and column ACLs before provisioning';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND c.oid NOT IN ('public.workspaces'::regclass,
                        'public.platform_feature_flags'::regclass,
                        'public.platform_feature_flag_targets'::regclass)
      AND c.relacl IS NOT NULL AND acl.grantee = 0
      AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) OR EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND c.oid NOT IN ('public.workspaces'::regclass,
                        'public.platform_feature_flags'::regclass,
                        'public.platform_feature_flag_targets'::regclass)
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attacl IS NOT NULL AND acl.grantee = 0
      AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
  ) THEN
    RAISE EXCEPTION 'PUBLIC has access to non-source relation columns; database owner must review table and column ACLs before provisioning an isolated observer';
  END IF;
END
$bootstrap$;

DO $role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'canonical_safe_state_reader') THEN
    RAISE EXCEPTION 'canonical_safe_state_reader already exists; audit it independently rather than reusing it';
  END IF;
  CREATE ROLE canonical_safe_state_reader
    LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOBYPASSRLS NOREPLICATION;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO canonical_safe_state_reader', current_database());
END
$role$;

ALTER ROLE canonical_safe_state_reader CONNECTION LIMIT 2;
ALTER ROLE canonical_safe_state_reader SET default_transaction_read_only = on;
ALTER ROLE canonical_safe_state_reader SET search_path = pg_catalog, public;
GRANT USAGE ON SCHEMA public TO canonical_safe_state_reader;

REVOKE ALL PRIVILEGES ON TABLE
  public.workspaces,
  public.platform_feature_flags,
  public.platform_feature_flag_targets
FROM canonical_safe_state_reader;

GRANT SELECT ON TABLE
  public.workspaces,
  public.platform_feature_flags,
  public.platform_feature_flag_targets
TO canonical_safe_state_reader;

-- Current workspace RLS permits cross-workspace directory reads only to the
-- separately credentialed merchant_ops role. Give this dedicated role a
-- SELECT-only directory policy; it receives no workspace write policy.
CREATE POLICY workspaces_canonical_safe_state_reader
  ON public.workspaces
  FOR SELECT
  TO canonical_safe_state_reader
  USING (current_user = 'canonical_safe_state_reader');

COMMENT ON ROLE canonical_safe_state_reader IS
  'Review-only canonical safe-state observer; SELECT-only; credentials and collector trust provisioned separately';

COMMIT;
