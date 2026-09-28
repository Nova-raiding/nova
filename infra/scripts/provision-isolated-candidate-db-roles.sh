#!/bin/sh
# Only the private demo candidate runs this before its first role bootstrap.
# Its three random runtime passwords arrive in the candidate Compose environment.
set -eu

command -v psql >/dev/null 2>&1 || { echo 'isolated candidate role provisioning failed' >&2; exit 1; }

read_password() {
  role=$1
  url=$2
  prefix="postgres://$role:"
  suffix='@postgres:5432/merchant'
  case "$url" in "$prefix"*"$suffix") ;; *) return 1 ;; esac
  password=${url#"$prefix"}
  password=${password%"$suffix"}
  [ "${#password}" -eq 48 ] || return 1
  case "$password" in *[!0123456789abcdef]*|'') return 1 ;; esac
  db_password=$password
}

read_password merchant_app "${DATABASE_URL:-}" || { echo 'isolated candidate role credentials are invalid' >&2; exit 1; }
app_password=$db_password
read_password merchant_ops "${OPS_DATABASE_URL:-}" || { echo 'isolated candidate role credentials are invalid' >&2; exit 1; }
ops_password=$db_password
read_password merchant_alert_receiver "${ALERT_RECEIVER_DATABASE_URL:-}" || { echo 'isolated candidate role credentials are invalid' >&2; exit 1; }
alert_password=$db_password
[ "$app_password" != "$ops_password" ] && [ "$app_password" != "$alert_password" ] && [ "$ops_password" != "$alert_password" ] || {
  echo 'isolated candidate role credentials are invalid' >&2
  exit 1
}

# No credential is passed in psql arguments or printed by this script. Suppress
# psql diagnostics too: a SQL error could otherwise echo the submitted text.
if ! psql -X -q -v ON_ERROR_STOP=1 >/dev/null 2>/dev/null <<SQL
BEGIN;
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    EXECUTE format('CREATE ROLE merchant_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', '$app_password');
  ELSE
    EXECUTE format('ALTER ROLE merchant_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', '$app_password');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    EXECUTE format('CREATE ROLE merchant_ops LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', '$ops_password');
  ELSE
    EXECUTE format('ALTER ROLE merchant_ops LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', '$ops_password');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_alert_receiver') THEN
    EXECUTE format('CREATE ROLE merchant_alert_receiver LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', '$alert_password');
  ELSE
    EXECUTE format('ALTER ROLE merchant_alert_receiver LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', '$alert_password');
  END IF;
END
\$\$;
COMMIT;
SQL
then
  echo 'isolated candidate role provisioning failed' >&2
  exit 1
fi
