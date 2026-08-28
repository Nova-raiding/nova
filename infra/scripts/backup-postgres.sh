#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:=./backups}"
mkdir -p "$BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$BACKUP_DIR/merchant-${timestamp}.dump"
umask 077
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$output"
sha256sum "$output" > "$output.sha256"
echo "backup written: $output"
