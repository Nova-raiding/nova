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

# Explicit, operator-approved checksum baseline.
#
# A schema_migrations row with no recorded checksum is an UNVERIFIED identity.
# Stamping it with the digest of whatever SQL file happens to be on disk would
# permanently certify an in-place edit made while the checksum was still null,
# so this runner fails closed instead. MIGRATION_BASELINE_ACCEPTED=true is the
# operator's explicit approval, and MIGRATION_BASELINE_CHECKSUMS carries the
# release-captured `version=sha256hex` entries, comma separated, that the
# approval covers. Nothing is honoured without the flag.
baseline_accepted=0
case "$(printf '%s' "${MIGRATION_BASELINE_ACCEPTED:-}" | tr '[:upper:]' '[:lower:]')" in
  true) baseline_accepted=1 ;;
esac

normalise_version() {
  value=$(printf '%s' "$1" | sed -E 's/^0+//')
  printf '%s' "${value:-0}"
}

# Accepted checksums for one version, pipe-delimited and padded ("|a|b|") so
# membership can be tested with position(...) inside psql. Just "|" when the
# operator has approved nothing for this version.
accepted_checksums() {
  version=$1
  approved=
  if [ "$baseline_accepted" -eq 1 ]; then
    case "$version" in
      144) approved="$approved 9519b2dbee21371a0bc7429c50e61ab3a677a4fd3965707328bd18489f2ad2e7" ;;
      168) approved="$approved 37f633fb25a7d1536f65a644a1adee3611c36ed416ac9a1bf3a10a1e92ab1ef1" ;;
      191) approved="$approved 36f8c9669ba99a392a874a76fa8d28b658211376a0e7e3131281247926202ba2" ;;
    esac
    for entry in $(printf '%s' "${MIGRATION_BASELINE_CHECKSUMS:-}" | tr ',' ' '); do
      case "$entry" in
        "$version"=*)
          candidate=${entry#*=}
          if printf '%s' "$candidate" | grep -Eq '^[a-f0-9]{64}$'; then approved="$approved $candidate"; fi
          ;;
      esac
    done
  fi
  printf '|'
  for checksum in $approved; do printf '%s|' "$checksum"; done
}

# Builds the post-apply probe for the indexes a non-transactional migration
# declares, empty when it declares none.
#
# CREATE INDEX CONCURRENTLY IF NOT EXISTS matches on the index NAME only, so a
# build that died mid-flight (deadlock, killed connection, unique violation,
# full disk) leaves an indisvalid=false index that every later retry silently
# skips. Recording that as applied would lose the index forever.
concurrent_index_probe() {
  names=$(sed -e 's/--.*$//' "$1" \
    | grep -Eoi 'CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX[[:space:]]+CONCURRENTLY[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?([A-Za-z_][A-Za-z0-9_$]*[[:space:]]*[.][[:space:]]*)?[A-Za-z_][A-Za-z0-9_$]*' \
    | sed -E 's/.*[^A-Za-z0-9_$]([A-Za-z_][A-Za-z0-9_$]*)$/\1/' \
    | sort -u)
  [ -n "$names" ] || return 0
  values=
  for name in $names; do values="${values}${values:+,}('$name')"; done
  cat <<PROBE
SELECT count(*) AS invalid_concurrent_indexes
  FROM (VALUES $values) AS probe(name)
  LEFT JOIN pg_class c ON c.relname = probe.name AND c.relkind = 'i' AND pg_table_is_visible(c.oid)
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
 WHERE c.oid IS NULL OR NOT i.indisvalid \\gset
\\if :invalid_concurrent_indexes
\\echo MIGRATION_CONCURRENT_INDEX_INVALID version :migration_version
\\echo indexes declared by this migration are missing or indisvalid=false
SELECT 1 / 0;
\\endif
PROBE
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
  version_key=$(normalise_version "$version")
  name=$(printf '%s' "$file" | sed -E 's/^[0-9]+_(.*)\.sql$/\1/')
  checksum=$(sha256_file "$migration")
  accepted=$(accepted_checksums "$version_key")
  if grep -Eq '^-- migrate:no-transaction$' "$migration"; then
    # Concurrent index operations cannot run in a transaction. Keep the
    # session lock and applied check in the same psql session. PostgreSQL
    # releases the lock automatically if ON_ERROR_STOP terminates psql.
    index_probe=$(concurrent_index_probe "$migration")
    psql -v ON_ERROR_STOP=1 -v migration_version="$version" -v migration_name="$name" -v migration_checksum="$checksum" -v accepted_checksums="$accepted" -v baseline_accepted="$baseline_accepted" <<SQL
SELECT pg_advisory_lock(731942851);
SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = :migration_version) AS migration_already_applied,
       COALESCE((SELECT name FROM schema_migrations WHERE version = :migration_version), '') AS applied_name,
       COALESCE((SELECT checksum FROM schema_migrations WHERE version = :migration_version), '') AS applied_checksum \\gset
\\if :migration_already_applied
SELECT (:'applied_name' <> :'migration_name' AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules' AND :'applied_checksum' = '' AND :'baseline_accepted' = '1')) AS migration_name_mismatch \gset
\if :migration_name_mismatch
\echo MIGRATION_NAME_MISMATCH version :migration_version
SELECT 1 / 0;
\endif
SELECT (:'applied_checksum' <> '' AND :'applied_checksum' <> :'migration_checksum' AND position(('|' || :'applied_checksum' || '|') IN :'accepted_checksums') = 0) AS migration_checksum_mismatch \gset
\if :migration_checksum_mismatch
\echo MIGRATION_CHECKSUM_MISMATCH version :migration_version
SELECT 1 / 0;
\endif
SELECT (:'applied_checksum' = '' AND position(('|' || :'migration_checksum' || '|') IN :'accepted_checksums') = 0 AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules' AND :'baseline_accepted' = '1')) AS migration_checksum_unverified \gset
\if :migration_checksum_unverified
\echo MIGRATION_CHECKSUM_UNVERIFIED version :migration_version has no approved checksum baseline
SELECT 1 / 0;
\endif
UPDATE schema_migrations SET checksum = :'migration_checksum' WHERE version = :migration_version AND checksum IS NULL AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules' AND :'baseline_accepted' = '1');
\\echo migration :migration_version already applied
\\else
\\echo applying migration :migration_version (:migration_name)
\\i '$migration'
$index_probe
INSERT INTO schema_migrations (version, name, checksum) VALUES (:migration_version, :'migration_name', :'migration_checksum');
\\endif
SELECT pg_advisory_unlock(731942851);
SQL
  else
    psql -v ON_ERROR_STOP=1 -v migration_version="$version" -v migration_name="$name" -v migration_checksum="$checksum" -v accepted_checksums="$accepted" -v baseline_accepted="$baseline_accepted" <<SQL
BEGIN;
SELECT pg_advisory_xact_lock(731942851);
SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = :migration_version) AS migration_already_applied,
       COALESCE((SELECT name FROM schema_migrations WHERE version = :migration_version), '') AS applied_name,
       COALESCE((SELECT checksum FROM schema_migrations WHERE version = :migration_version), '') AS applied_checksum \\gset
\\if :migration_already_applied
SELECT (:'applied_name' <> :'migration_name' AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules' AND :'applied_checksum' = '' AND :'baseline_accepted' = '1')) AS migration_name_mismatch \gset
\if :migration_name_mismatch
\echo MIGRATION_NAME_MISMATCH version :migration_version
SELECT 1 / 0;
\endif
SELECT (:'applied_checksum' <> '' AND :'applied_checksum' <> :'migration_checksum' AND position(('|' || :'applied_checksum' || '|') IN :'accepted_checksums') = 0) AS migration_checksum_mismatch \gset
\if :migration_checksum_mismatch
\echo MIGRATION_CHECKSUM_MISMATCH version :migration_version
SELECT 1 / 0;
\endif
SELECT (:'applied_checksum' = '' AND position(('|' || :'migration_checksum' || '|') IN :'accepted_checksums') = 0 AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules' AND :'baseline_accepted' = '1')) AS migration_checksum_unverified \gset
\if :migration_checksum_unverified
\echo MIGRATION_CHECKSUM_UNVERIFIED version :migration_version has no approved checksum baseline
SELECT 1 / 0;
\endif
UPDATE schema_migrations SET checksum = :'migration_checksum' WHERE version = :migration_version AND checksum IS NULL AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules' AND :'baseline_accepted' = '1');
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
