#!/bin/sh
set -eu
umask 077

: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${BACKUP_CHECKSUM_FILE:=$BACKUP_FILE.sha256}"
: "${BACKUP_ATTESTATION_PATH:=$BACKUP_FILE.attestation.json}"
: "${EXPECTED_BACKUP_SHA256:?EXPECTED_BACKUP_SHA256 is required}"
: "${EXPECTED_SOURCE_DATABASE_ID_SHA256:?EXPECTED_SOURCE_DATABASE_ID_SHA256 is required}"
: "${EXPECTED_MIGRATION_VERSION:?EXPECTED_MIGRATION_VERSION is required}"
: "${POSTGRES_IMAGE_REF:?POSTGRES_IMAGE_REF is required}"
: "${RESTORE_STATE_ROOT:=/var/lib/merchant-release-security/preview-restores}"
: "${TRUST_DIR:=/run/release-security/evidence-trust}"
: "${VERIFY_PREVIEW_INPUTS:?VERIFY_PREVIEW_INPUTS is required}"

case "$EXPECTED_MIGRATION_VERSION" in ''|*[!0-9]*) echo 'EXPECTED_MIGRATION_VERSION must be an integer' >&2; exit 2;; esac
[ "$EXPECTED_MIGRATION_VERSION" -gt 0 ] || { echo 'EXPECTED_MIGRATION_VERSION must be positive' >&2; exit 2; }
printf '%s' "$EXPECTED_BACKUP_SHA256" | grep -Eq '^[a-f0-9]{64}$' || { echo 'EXPECTED_BACKUP_SHA256 invalid' >&2; exit 2; }
printf '%s' "$EXPECTED_SOURCE_DATABASE_ID_SHA256" | grep -Eq '^[a-f0-9]{64}$' || { echo 'EXPECTED_SOURCE_DATABASE_ID_SHA256 invalid' >&2; exit 2; }
printf '%s' "$POSTGRES_IMAGE_REF" | grep -Eq '^.+/postgres@sha256:[a-f0-9]{64}$' || { echo 'POSTGRES_IMAGE_REF must be immutable postgres digest' >&2; exit 2; }
[ -z "${DATABASE_URL:-}${OPS_DATABASE_URL:-}${PGHOST:-}" ] || { echo 'production database variables are forbidden' >&2; exit 2; }
for f in "$BACKUP_FILE" "$BACKUP_CHECKSUM_FILE" "$BACKUP_ATTESTATION_PATH" "$TRUST_DIR/production-evidence-public.pem" "$TRUST_DIR/production-evidence-key-id"; do [ -f "$f" ] && [ ! -L "$f" ] || { echo "protected input missing or symlink: $f" >&2; exit 1; }; done
node "$VERIFY_PREVIEW_INPUTS" --backup "$(realpath "$BACKUP_FILE")" --checksum "$(realpath "$BACKUP_CHECKSUM_FILE")" --attestation "$(realpath "$BACKUP_ATTESTATION_PATH")" --public-key "$(realpath "$TRUST_DIR/production-evidence-public.pem")" --key-id-file "$(realpath "$TRUST_DIR/production-evidence-key-id")" --expected-source-database-id-sha256 "$EXPECTED_SOURCE_DATABASE_ID_SHA256" --expected-backup-sha256 "$EXPECTED_BACKUP_SHA256" >/dev/null
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 1; }
docker image inspect "$POSTGRES_IMAGE_REF" >/dev/null
mkdir -p "$RESTORE_STATE_ROOT"
nonce=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
project="merchant_pg16_restore_${nonce}"
state="$RESTORE_STATE_ROOT/$project"
mkdir "$state"
# Retain the isolated volume and logs for independently reviewable restore evidence;
# no production volume is ever addressed by this project-scoped Compose name.
trap 'docker compose -p "$project" -f "$state/compose.yml" down >/dev/null 2>&1 || true' EXIT HUP INT TERM
cat >"$state/compose.yml" <<EOF
services:
  postgres:
    image: $POSTGRES_IMAGE_REF
    environment:
      POSTGRES_PASSWORD: isolated-only
      POSTGRES_DB: merchant
    networks: [restore]
    volumes: [data:/var/lib/postgresql/data]
networks:
  restore:
    internal: true
volumes:
  data:
EOF
docker compose -p "$project" -f "$state/compose.yml" up -d postgres
docker compose -p "$project" -f "$state/compose.yml" exec -T postgres sh -eu -c 'i=0; until pg_isready -U postgres -d merchant >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 60 ] || exit 1; sleep 1; done'
docker compose -p "$project" -f "$state/compose.yml" exec -T postgres psql -U postgres -d merchant -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN CREATE ROLE merchant_app LOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_ops') THEN CREATE ROLE merchant_ops LOGIN; END IF; END $$;
ALTER ROLE merchant_app SET default_transaction_read_only=on;
ALTER ROLE merchant_ops SET default_transaction_read_only=on;
SQL
if ! docker compose -p "$project" -f "$state/compose.yml" exec -T postgres pg_restore -U postgres -d merchant --exit-on-error --no-owner --no-privileges <"$BACKUP_FILE" >"$state/restore.log" 2>&1; then echo "isolated restore failed; log=$state/restore.log" >&2; exit 1; fi
actual=$(docker compose -p "$project" -f "$state/compose.yml" exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d merchant -c 'select max(version)::int from schema_migrations')
[ "$actual" = "$EXPECTED_MIGRATION_VERSION" ] || { echo "restored migration version $actual does not match expected $EXPECTED_MIGRATION_VERSION" >&2; exit 1; }
printf '%s\n' "isolated restore passed: project=$project migration=$actual state=$state"
