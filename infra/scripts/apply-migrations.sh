#!/bin/sh
set -eu

: "${PGHOST:=postgres}"
: "${PGPORT:=5432}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

psql -v ON_ERROR_STOP=1 -c 'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())'

for migration in /migrations/[0-9][0-9][0-9]_*.sql; do
  [ -f "$migration" ] || continue
  file=$(basename "$migration")
  version=$(printf '%s' "$file" | cut -d_ -f1)
  name=$(printf '%s' "$file" | sed -E 's/^[0-9]+_(.*)\.sql$/\1/')
  applied=$(psql -Atqc "SELECT 1 FROM schema_migrations WHERE version = ${version}")
  if [ "$applied" = "1" ]; then
    echo "migration ${version} already applied"
    continue
  fi
  echo "applying migration ${version} (${name})"
  psql -v ON_ERROR_STOP=1 <<SQL
BEGIN;
SELECT pg_advisory_xact_lock(731942851);
\\i '$migration'
INSERT INTO schema_migrations (version, name) VALUES (${version}, '${name}');
COMMIT;
SQL
done

echo "migrations complete"
