#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:=./backups}"
mkdir -p "$BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$BACKUP_DIR/merchant-${timestamp}.dump"
umask 077
temporary=$(mktemp "$BACKUP_DIR/.merchant-${timestamp}.XXXXXX.dump")
temporary_checksum="$temporary.sha256"
cleanup() { rm -f -- "$temporary" "$temporary_checksum"; }
trap cleanup EXIT HUP INT TERM
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$temporary"
test -s "$temporary"
sha256sum "$temporary" > "$temporary_checksum"
mv -f -- "$temporary" "$output"
mv -f -- "$temporary_checksum" "$output.sha256"
trap - EXIT HUP INT TERM
echo "backup written: $output"
