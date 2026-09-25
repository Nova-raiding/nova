#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required to grant Ops migration-history read access}"
: "${PGDATABASE:?PGDATABASE is required to grant Ops migration-history read access}"
: "${PGUSER:?PGUSER is required to grant Ops migration-history read access}"
: "${PGPASSWORD:?PGPASSWORD is required to grant Ops migration-history read access}"

command -v psql >/dev/null 2>&1 || { echo 'psql is required to grant Ops migration-history read access' >&2; exit 1; }

# PGUSER is the schema owner used by the migration service. This is a narrow,
# idempotent metadata grant; it exposes no tenant or operational business data.
psql -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    RAISE EXCEPTION 'merchant_ops role is missing';
  END IF;
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM merchant_ops';
  EXECUTE 'GRANT SELECT ON TABLE public.schema_migrations TO merchant_ops';
END
$$;
SQL
