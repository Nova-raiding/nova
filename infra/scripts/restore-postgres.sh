#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${CONFIRM_RESTORE:?Set CONFIRM_RESTORE=YES to restore}"
: "${RESTORE_TARGET_ENVIRONMENT:?Set RESTORE_TARGET_ENVIRONMENT=local or production}"
[ "$CONFIRM_RESTORE" = YES ] || { echo "restore refused" >&2; exit 2; }
[ "$RESTORE_TARGET_ENVIRONMENT" = local ] || [ "$RESTORE_TARGET_ENVIRONMENT" = production ] || { echo "RESTORE_TARGET_ENVIRONMENT must be local or production" >&2; exit 2; }
[ -f "$BACKUP_FILE" ] || { echo "backup not found: $BACKUP_FILE" >&2; exit 1; }
[ ! -L "$BACKUP_FILE" ] || { echo "backup must not be a symbolic link: $BACKUP_FILE" >&2; exit 1; }
verified_backup=$(mktemp "${TMPDIR:-/tmp}/merchant-verified-backup.XXXXXX")
trap 'rm -f -- "$verified_backup"' EXIT HUP INT TERM
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd -P)
cp "$BACKUP_FILE" "$verified_backup"
source_before=$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')
copy_hash=$(shasum -a 256 "$verified_backup" | awk '{print $1}')
[ "$source_before" = "$copy_hash" ] || { echo "backup changed while creating verified restore copy" >&2; exit 1; }
case "${RESTORE_ALLOW_UNSIGNED_LOCAL:-}" in
  YES)
    [ "$RESTORE_TARGET_ENVIRONMENT" = local ] || { echo "unsigned restore requires RESTORE_TARGET_ENVIRONMENT=local" >&2; exit 1; }
    [ "${NODE_ENV:-}" != production ] || { echo "unsigned local restore is forbidden in production" >&2; exit 1; }
    printf '%s' "$DATABASE_URL" | grep -Eq '^postgres(ql)?://[^/@]+(:[^/@]*)?@(localhost|127\.0\.0\.1)(:|/)' || { echo "unsigned restore is limited to an explicit localhost database" >&2; exit 1; }
    [ -f "$BACKUP_FILE.sha256" ] || { echo "backup checksum sidecar not found: $BACKUP_FILE.sha256" >&2; exit 1; }
    sha256sum -c "$BACKUP_FILE.sha256"
    ;;
  '')
  [ "$RESTORE_TARGET_ENVIRONMENT" = production ] || { echo "signed restore requires RESTORE_TARGET_ENVIRONMENT=production" >&2; exit 1; }
    [ "${RESTORE_TARGET_ISOLATED:-}" = YES ] || { echo "signed restore requires RESTORE_TARGET_ISOLATED=YES after independent-target review" >&2; exit 2; }
    : "${BACKUP_ATTESTATION_PATH:?production restore requires BACKUP_ATTESTATION_PATH}"
    : "${EXPECTED_SOURCE_DATABASE_ID_SHA256:?EXPECTED_SOURCE_DATABASE_ID_SHA256 is required}"
    command -v node >/dev/null 2>&1 || { echo "node is required for production target preflight" >&2; exit 1; }
    node "$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)/validate-production-database-url.mjs" DATABASE_URL
    target_database_id=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT system_identifier::text FROM pg_control_system()')
  target_database_id=$(printf '%s' "$target_database_id" | tr -d '[:space:]')
  [ -n "$target_database_id" ] || { echo "target database identity could not be read" >&2; exit 1; }
  target_database_id_sha256=$(printf '%s' "$target_database_id" | sha256sum | awk '{print $1}')
  [ "$target_database_id_sha256" != "$EXPECTED_SOURCE_DATABASE_ID_SHA256" ] || { echo "restore target database identity matches approved source; isolated target is required" >&2; exit 1; }
    sh "$root/infra/scripts/validate-production-evidence-trust.sh" "$root"
  trust_dir=/run/release-security/evidence-trust
  trusted_key_id=$(sed -n '1p' "$trust_dir/production-evidence-key-id")
  npx --no-install tsx "$root/tests/backup-attestation-gate.ts" --file "$BACKUP_ATTESTATION_PATH" --backup "$verified_backup" --expected-backup-file-name "$(basename "$BACKUP_FILE")" --public-key "$trust_dir/production-evidence-public.pem" --key-id "$trusted_key_id" --expected-source-database-id-sha256 "$EXPECTED_SOURCE_DATABASE_ID_SHA256"
    ;;
  *) echo "RESTORE_ALLOW_UNSIGNED_LOCAL must be YES or unset" >&2; exit 2 ;;
esac
source_after=$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')
[ "$source_before" = "$source_after" ] || { echo "source backup changed during verification" >&2; exit 1; }

# A restore is not complete until the target has been brought to the checked-in
# schema and every real runtime surface has passed its own fail-closed smoke.
# Hooks are injected by the deployment environment; this script never emits
# synthetic evidence for an unavailable API, worker, or installed plugin.
require_executable_hook() {
  hook_name=$1
  hook_path=$2
  [ -n "$hook_path" ] || { echo "$hook_name is required after restore" >&2; exit 1; }
  [ -f "$hook_path" ] || { echo "$hook_name must point to a regular executable file" >&2; exit 1; }
  [ ! -L "$hook_path" ] || { echo "$hook_name must not be a symbolic link" >&2; exit 1; }
  [ -x "$hook_path" ] || { echo "$hook_name must be executable" >&2; exit 1; }
}

migration_script=${RESTORE_MIGRATION_SCRIPT:-}
if [ -n "$migration_script" ]; then
  require_executable_hook RESTORE_MIGRATION_SCRIPT "$migration_script"
else
  command -v npx >/dev/null 2>&1 || { echo 'npx is required to run post-restore migrations' >&2; exit 1; }
  migration_script="$root/apps/api/src/migrate.ts"
  [ -f "$migration_script" ] || { echo "post-restore migration entrypoint not found: $migration_script" >&2; exit 1; }
fi

db_probe_script=${RESTORE_DB_PROBE_SCRIPT:-$root/infra/scripts/verify-runtime-db-role.sh}
api_smoke_script=${RESTORE_API_SMOKE_SCRIPT:-}
worker_smoke_script=${RESTORE_WORKER_SMOKE_SCRIPT:-}
plugin_smoke_script=${RESTORE_PLUGIN_SMOKE_SCRIPT:-}
require_executable_hook RESTORE_DB_PROBE_SCRIPT "$db_probe_script"
require_executable_hook RESTORE_API_SMOKE_SCRIPT "$api_smoke_script"
require_executable_hook RESTORE_WORKER_SMOKE_SCRIPT "$worker_smoke_script"
require_executable_hook RESTORE_PLUGIN_SMOKE_SCRIPT "$plugin_smoke_script"

pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$verified_backup"
if [ -n "${RESTORE_MIGRATION_SCRIPT:-}" ]; then
  "$migration_script"
else
  npx --no-install tsx "$migration_script"
fi
"$db_probe_script"
"$api_smoke_script"
"$worker_smoke_script"
"$plugin_smoke_script"
echo "restore completed; migration, database role/RLS/ACL, API, worker, and plugin smoke gates passed"
