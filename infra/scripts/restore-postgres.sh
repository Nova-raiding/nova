#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${CONFIRM_RESTORE:?Set CONFIRM_RESTORE=YES to restore}"
[ "$CONFIRM_RESTORE" = YES ] || { echo "restore refused" >&2; exit 2; }
[ -f "$BACKUP_FILE" ] || { echo "backup not found: $BACKUP_FILE" >&2; exit 1; }
verified_backup=$(mktemp "${TMPDIR:-/tmp}/merchant-verified-backup.XXXXXX")
trap 'rm -f -- "$verified_backup"' EXIT HUP INT TERM
cp "$BACKUP_FILE" "$verified_backup"
source_before=$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')
copy_hash=$(shasum -a 256 "$verified_backup" | awk '{print $1}')
[ "$source_before" = "$copy_hash" ] || { echo "backup changed while creating verified restore copy" >&2; exit 1; }
case "${RESTORE_ALLOW_UNSIGNED_LOCAL:-}" in
  YES)
    [ "${NODE_ENV:-}" != production ] || { echo "unsigned local restore is forbidden in production" >&2; exit 1; }
    printf '%s' "$DATABASE_URL" | grep -Eq '^postgres(ql)?://[^/@]+(:[^/@]*)?@(localhost|127\.0\.0\.1)(:|/)' || { echo "unsigned restore is limited to an explicit localhost database" >&2; exit 1; }
    [ -f "$BACKUP_FILE.sha256" ] || { echo "backup checksum sidecar not found: $BACKUP_FILE.sha256" >&2; exit 1; }
    sha256sum -c "$BACKUP_FILE.sha256"
    ;;
  '')
  [ "${RESTORE_TARGET_ISOLATED:-}" = YES ] || { echo "signed restore requires RESTORE_TARGET_ISOLATED=YES after independent-target review" >&2; exit 2; }
  : "${BACKUP_ATTESTATION_PATH:?production restore requires BACKUP_ATTESTATION_PATH}"
  : "${EXPECTED_SOURCE_DATABASE_ID_SHA256:?EXPECTED_SOURCE_DATABASE_ID_SHA256 is required}"
  root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd -P)
  sh "$root/infra/scripts/validate-production-evidence-trust.sh" "$root"
  trust_dir=/run/release-security/evidence-trust
  trusted_key_id=$(sed -n '1p' "$trust_dir/production-evidence-key-id")
  npx --no-install tsx "$root/tests/backup-attestation-gate.ts" --file "$BACKUP_ATTESTATION_PATH" --backup "$verified_backup" --expected-backup-file-name "$(basename "$BACKUP_FILE")" --public-key "$trust_dir/production-evidence-public.pem" --key-id "$trusted_key_id" --expected-source-database-id-sha256 "$EXPECTED_SOURCE_DATABASE_ID_SHA256"
    ;;
  *) echo "RESTORE_ALLOW_UNSIGNED_LOCAL must be YES or unset" >&2; exit 2 ;;
esac
source_after=$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')
[ "$source_before" = "$source_after" ] || { echo "source backup changed during verification" >&2; exit 1; }
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$verified_backup"
echo "restore completed; run migrations and smoke checks before enabling traffic"
