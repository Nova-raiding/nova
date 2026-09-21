#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${OPS_DATABASE_URL:?OPS_DATABASE_URL is required}"
: "${EXPECTED_MIGRATION_VERSION:?EXPECTED_MIGRATION_VERSION is required}"
migration_chain_mode=${MIGRATION_CHAIN_MODE:-complete}
case "$migration_chain_mode" in
  prefix|complete) ;;
  *) echo 'MIGRATION_CHAIN_MODE must be prefix or complete' >&2; exit 2 ;;
esac

command -v psql >/dev/null 2>&1 || { echo 'psql is required to verify the database migration chain' >&2; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo 'shasum is required to verify the database migration chain' >&2; exit 1; }

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
migrations_dir=${MIGRATIONS_DIR:-$root/packages/persistence/src/migrations}
[ -d "$migrations_dir" ] || { echo "migration directory not found: $migrations_dir" >&2; exit 1; }

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/merchant-migration-chain.XXXXXX")
cleanup() { rm -f -- "$temporary_dir/expected" "$temporary_dir/tenant" "$temporary_dir/ops"; rmdir -- "$temporary_dir" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM

: > "$temporary_dir/expected"
expected_version=1
for migration in "$migrations_dir"/[0-9][0-9][0-9]_*.sql; do
  [ -f "$migration" ] || { echo 'no versioned migrations found' >&2; exit 1; }
  filename=${migration##*/}
  version=${filename%%_*}
  version_decimal=$(printf '%s' "$version" | sed 's/^0*//')
  [ -n "$version_decimal" ] || version_decimal=0
  [ "$version_decimal" -eq "$expected_version" ] || {
    echo "workspace migration chain is not contiguous at version $expected_version" >&2
    exit 1
  }
  name=${filename#*_}
  name=${name%.sql}
  checksum=$(shasum -a 256 "$migration" | awk '{print $1}')
  printf '%s\t%s\t%s\n' "$version_decimal" "$name" "$checksum" >> "$temporary_dir/expected"
  expected_version=$((expected_version + 1))
done

workspace_tail=$((expected_version - 1))
[ "$workspace_tail" -eq "$EXPECTED_MIGRATION_VERSION" ] 2>/dev/null || {
  echo "release migration chain tail mismatch: expected $EXPECTED_MIGRATION_VERSION, workspace has $workspace_tail" >&2
  exit 1
}

verify_target() {
  target_name=$1
  target_url=$2
  actual_path=$3
  psql "$target_url" -X -A -t -F '|' -v ON_ERROR_STOP=1 -c \
    "SELECT version, name, coalesce(checksum, '') FROM public.schema_migrations ORDER BY version" \
    > "$actual_path"

  awk -F '[|\t]' -v target="$target_name" -v mode="$migration_chain_mode" '
    NR == FNR { version[++expected_count]=$1; name[$1]=$2; checksum[$1]=$3; next }
    {
      actual_count++
      if (actual_count > expected_count) fail="migration history is ahead of candidate at version " $1
      v=$1
      if (fail == "" && v != version[actual_count]) fail="migration history is missing or has an unexpected version at " version[actual_count]
      legacy_name=(v == 14 && $2 == "read_only_schedules" && $3 == "")
      if (fail == "" && $2 != name[v] && !legacy_name) fail="migration " v " name mismatch"
      legacy_checksum=(v == 144 && $3 == "9519b2dbee21371a0bc7429c50e61ab3a677a4fd3965707328bd18489f2ad2e7") ||
        (v == 168 && $3 == "37f633fb25a7d1536f65a644a1adee3611c36ed416ac9a1bf3a10a1e92ab1ef1") ||
        (v == 191 && $3 == "36f8c9669ba99a392a874a76fa8d28b658211376a0e7e3131281247926202ba2")
      if (fail == "" && $3 != checksum[v] && !legacy_name && !legacy_checksum) fail="migration " v " checksum mismatch"
      if (fail != "") { print target ": " fail > "/dev/stderr"; exit 1 }
    }
    END {
      if (fail == "" && mode == "complete" && actual_count != expected_count) {
        print target ": migration history length mismatch: expected " expected_count ", found " actual_count > "/dev/stderr"
        exit 1
      }
    }
  ' "$temporary_dir/expected" "$actual_path"
}

verify_target DATABASE_URL "$DATABASE_URL" "$temporary_dir/tenant"
verify_target OPS_DATABASE_URL "$OPS_DATABASE_URL" "$temporary_dir/ops"
cmp -s "$temporary_dir/tenant" "$temporary_dir/ops" || {
  echo 'tenant and Ops migration histories differ' >&2
  exit 1
}
applied_tail=$(wc -l < "$temporary_dir/tenant" | tr -d ' ')
if [ "$migration_chain_mode" = complete ]; then
  echo "database migration chain verified through tenant and Ops roles: mode=complete versions=1-$workspace_tail checksums=matched"
else
  [ "$applied_tail" -eq 0 ] && applied_range=none || applied_range="1-$applied_tail"
  echo "database migration chain verified through tenant and Ops roles: mode=prefix applied=$applied_range candidate=1-$workspace_tail checksums=matched"
fi
