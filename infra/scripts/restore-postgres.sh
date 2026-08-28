#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${CONFIRM_RESTORE:?Set CONFIRM_RESTORE=YES to restore}"
[ "$CONFIRM_RESTORE" = YES ] || { echo "restore refused" >&2; exit 2; }
if [ "${NODE_ENV:-}" = production ] && [ "${RESTORE_TARGET_ISOLATED:-}" != YES ]; then
  echo "production restore requires an isolated recovery target; set RESTORE_TARGET_ISOLATED=YES after independent-target review" >&2
  exit 2
fi
[ -f "$BACKUP_FILE" ] || { echo "backup not found: $BACKUP_FILE" >&2; exit 1; }
[ -f "$BACKUP_FILE.sha256" ] || { echo "backup checksum sidecar not found: $BACKUP_FILE.sha256" >&2; exit 1; }
sha256sum -c "$BACKUP_FILE.sha256"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$BACKUP_FILE"
echo "restore completed; run migrations and smoke checks before enabling traffic"
