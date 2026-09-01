#!/bin/sh
set -eu

: "${PGHOST:=postgres}"
: "${PGPORT:=5432}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Validate the migration artifact before opening a database connection. The
# shell runner must never execute a partial, duplicated, or unsafe filename
# set merely because the database history happens to be compatible.
known_versions=
latest_version=0
expected_version=1
migration_count=0
for migration in /migrations/[0-9][0-9][0-9]_*.sql; do
  [ -f "$migration" ] || continue
  file=$(basename "$migration")
  if ! printf '%s\n' "$file" | grep -Eq '^[0-9]{3}_[a-z0-9][a-z0-9_]*\.sql$'; then
    echo "MIGRATION_FILENAME_INVALID: $file" >&2
    exit 1
  fi
  version=$(printf '%s' "$file" | cut -d_ -f1)
  version_number=$(printf '%s\n' "$version" | awk '{ print $1 + 0 }')
  if [ "$version_number" -ne "$expected_version" ]; then
    echo "MIGRATION_ARTIFACT_CHAIN_GAP: expected $(printf '%03d' "$expected_version"), found $version" >&2
    exit 1
  fi
  latest_version=$version_number
  expected_version=$((expected_version + 1))
  migration_count=$((migration_count + 1))
  known_versions="${known_versions:+$known_versions,}$version"
done
if [ "$migration_count" -eq 0 ]; then
  echo 'MIGRATION_ARTIFACTS_EMPTY: no migration SQL files found' >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -c 'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())'
psql -v ON_ERROR_STOP=1 -c 'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text'

# Refuse a database history written by a newer/foreign release before any
# migration is applied. The application runner performs the same check for a
# complete release chain; keeping it here prevents the shell path from
# silently reporting success on an incompatible history.
if [ -n "$known_versions" ]; then
  psql -v ON_ERROR_STOP=1 -v known_versions="$known_versions" -v latest_version="$latest_version" <<SQL
SELECT pg_advisory_lock(731942851);
SELECT EXISTS (
  SELECT 1 FROM schema_migrations WHERE version NOT IN (:known_versions)
) AS migration_version_unknown \gset
\if :migration_version_unknown
\echo MIGRATION_VERSION_UNKNOWN: database contains a version outside this release
SELECT 1 / 0;
\endif
SELECT EXISTS (
  SELECT 1
  FROM generate_series(1, :latest_version) AS expected(version)
  LEFT JOIN schema_migrations applied ON applied.version = expected.version
  WHERE applied.version IS NULL
    AND expected.version <= COALESCE((SELECT max(version) FROM schema_migrations), 0)
) AS migration_history_gap \gset
\if :migration_history_gap
\echo MIGRATION_HISTORY_GAP: database migration history is not a contiguous prefix
SELECT 1 / 0;
\endif
SQL
fi

for migration in /migrations/[0-9][0-9][0-9]_*.sql; do
  [ -f "$migration" ] || continue
  file=$(basename "$migration")
  version=$(printf '%s' "$file" | cut -d_ -f1)
  name=$(printf '%s' "$file" | sed -E 's/^[0-9]+_(.*)\.sql$/\1/')
  checksum=$(sha256_file "$migration")
  if grep -Eq '^-- migrate:no-transaction$' "$migration"; then
    # Concurrent index operations cannot run in a transaction. Keep the
    # session lock and applied check in the same psql session. PostgreSQL
    # releases the lock automatically if ON_ERROR_STOP terminates psql.
    psql -v ON_ERROR_STOP=1 -v migration_version="$version" -v migration_name="$name" -v migration_checksum="$checksum" <<SQL
SELECT pg_advisory_lock(731942851);
SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = :migration_version) AS migration_already_applied,
       COALESCE((SELECT name FROM schema_migrations WHERE version = :migration_version), '') AS applied_name,
       COALESCE((SELECT checksum FROM schema_migrations WHERE version = :migration_version), '') AS applied_checksum \\gset
\\if :migration_already_applied
SELECT (:'applied_name' <> :'migration_name' AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules')) AS migration_name_mismatch \gset
\if :migration_name_mismatch
\echo MIGRATION_NAME_MISMATCH version :migration_version
SELECT 1 / 0;
\endif
SELECT (:'applied_checksum' <> '' AND :'applied_checksum' <> :'migration_checksum' AND NOT (:migration_version = 144 AND :'applied_checksum' = '9519b2dbee21371a0bc7429c50e61ab3a677a4fd3965707328bd18489f2ad2e7')) AS migration_checksum_mismatch \gset
\if :migration_checksum_mismatch
\echo MIGRATION_CHECKSUM_MISMATCH version :migration_version
SELECT 1 / 0;
\endif
UPDATE schema_migrations SET checksum = :'migration_checksum' WHERE version = :migration_version AND checksum IS NULL AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules');
\\echo migration :migration_version already applied
\\else
\\echo applying migration :migration_version (:migration_name)
\\i '$migration'
INSERT INTO schema_migrations (version, name, checksum) VALUES (:migration_version, :'migration_name', :'migration_checksum');
\\endif
SELECT pg_advisory_unlock(731942851);
SQL
  else
    psql -v ON_ERROR_STOP=1 -v migration_version="$version" -v migration_name="$name" -v migration_checksum="$checksum" <<SQL
BEGIN;
SELECT pg_advisory_xact_lock(731942851);
SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = :migration_version) AS migration_already_applied,
       COALESCE((SELECT name FROM schema_migrations WHERE version = :migration_version), '') AS applied_name,
       COALESCE((SELECT checksum FROM schema_migrations WHERE version = :migration_version), '') AS applied_checksum \\gset
\\if :migration_already_applied
SELECT (:'applied_name' <> :'migration_name' AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules')) AS migration_name_mismatch \gset
\if :migration_name_mismatch
\echo MIGRATION_NAME_MISMATCH version :migration_version
SELECT 1 / 0;
\endif
SELECT (:'applied_checksum' <> '' AND :'applied_checksum' <> :'migration_checksum' AND NOT (:migration_version = 144 AND :'applied_checksum' = '9519b2dbee21371a0bc7429c50e61ab3a677a4fd3965707328bd18489f2ad2e7')) AS migration_checksum_mismatch \gset
\if :migration_checksum_mismatch
\echo MIGRATION_CHECKSUM_MISMATCH version :migration_version
SELECT 1 / 0;
\endif
UPDATE schema_migrations SET checksum = :'migration_checksum' WHERE version = :migration_version AND checksum IS NULL AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules');
\\echo migration :migration_version already applied
\\else
\\echo applying migration :migration_version (:migration_name)
\\i '$migration'
INSERT INTO schema_migrations (version, name, checksum) VALUES (:migration_version, :'migration_name', :'migration_checksum');
\\endif
COMMIT;
SQL
  fi
done

echo "migrations complete"
