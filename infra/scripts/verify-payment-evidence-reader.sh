#!/bin/sh
set -eu

# REVIEW_ONLY: authenticate as the dedicated reader through a protected libpq
# service file. The SQL emits a verdict only, never payment rows or credentials.
command -v psql >/dev/null 2>&1 || { echo 'psql is required' >&2; exit 1; }
: "${PAYMENT_EVIDENCE_PGSERVICE:?PAYMENT_EVIDENCE_PGSERVICE is required}"
: "${PGSERVICEFILE:?PGSERVICEFILE is required}"
printf '%s' "$PAYMENT_EVIDENCE_PGSERVICE" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' || {
  echo 'PAYMENT_EVIDENCE_PGSERVICE must be a simple service name' >&2; exit 1;
}
case "$PGSERVICEFILE" in /*) ;; *) echo 'PGSERVICEFILE must be absolute' >&2; exit 1 ;; esac
service_real=$(realpath "$PGSERVICEFILE")
[ "$service_real" = "$PGSERVICEFILE" ] && [ -f "$service_real" ] && [ ! -L "$service_real" ] || {
  echo 'PGSERVICEFILE must be a canonical regular file' >&2; exit 1;
}
service_mode=$(stat -c '%a' "$service_real" 2>/dev/null || stat -f '%Lp' "$service_real")
service_uid=$(stat -c '%u' "$service_real" 2>/dev/null || stat -f '%u' "$service_real")
[ "$service_mode" = 600 ] && [ "$service_uid" = "$(id -u)" ] || {
  echo 'PGSERVICEFILE must be owned by this uid and mode 0600' >&2; exit 1;
}
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
sql_file=$script_dir/../protected/verify-payment-evidence-reader.sql
[ -f "$sql_file" ] && [ ! -L "$sql_file" ] || { echo 'reviewed verifier SQL missing' >&2; exit 1; }
result=$(psql "service=$PAYMENT_EVIDENCE_PGSERVICE" -X -qAt -v ON_ERROR_STOP=1 -f "$sql_file")
[ "$result" = 'payment-evidence-reader:ok' ] || {
  echo 'payment evidence reader ACL/RLS verification failed; no evidence produced' >&2; exit 1;
}
echo 'payment evidence reader ACL/RLS verified (review-only; no release evidence produced)'
