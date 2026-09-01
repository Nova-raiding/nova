#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:=./backups}"
mkdir -p "$BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$BACKUP_DIR/merchant-${timestamp}.dump"
umask 077
reservation="$output.lock"
if [ -e "$output" ] || [ -e "$output.sha256" ]; then
  echo "backup output already exists: $output" >&2
  exit 1
fi
if ! mkdir -- "$reservation" 2>/dev/null; then
  echo "backup output is already being created: $output" >&2
  exit 1
fi
temporary=$(mktemp "$BACKUP_DIR/.merchant-${timestamp}.XXXXXX.dump")
temporary_checksum="$temporary.sha256"
cleanup() { rm -f -- "$temporary" "$temporary_checksum"; rmdir -- "$reservation" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$temporary"
test -s "$temporary"
checksum=$(sha256sum "$temporary" | awk '{print $1}')
printf '%s  %s\n' "$checksum" "$output" > "$temporary_checksum"
mv -- "$temporary" "$output"
mv -- "$temporary_checksum" "$output.sha256"
trap - EXIT HUP INT TERM
rmdir -- "$reservation"
echo "backup written: $output"
