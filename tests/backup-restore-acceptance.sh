#!/bin/sh
set -eu

# Disposable local drill. It proves the repository backup artifact can be
# restored into a clean PostgreSQL database and that migrations/business data
# remain readable. Managed-cloud PITR and KMS are separate deployment gates.
compose_file=infra/local/docker-compose.yml
db_container_service=postgres
restore_db="merchant_restore_$(date +%s)"
work_dir=$(mktemp -d)
backup_file="$work_dir/merchant.dump"
cleanup() {
  docker compose -f "$compose_file" exec -T "$db_container_service" dropdb --if-exists -U merchant "$restore_db" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

docker compose -f "$compose_file" up -d postgres migrate >/dev/null
docker compose -f "$compose_file" exec -T "$db_container_service" pg_dump -U merchant -d merchant --format=custom --no-owner --no-privileges > "$backup_file"
test -s "$backup_file"
sha256sum "$backup_file" > "$backup_file.sha256"
sha256sum -c "$backup_file.sha256" >/dev/null
docker compose -f "$compose_file" exec -T "$db_container_service" createdb -U merchant "$restore_db"
docker compose -f "$compose_file" exec -T "$db_container_service" pg_restore -U merchant -d "$restore_db" --no-owner --no-privileges < "$backup_file"

schema_versions=$(docker compose -f "$compose_file" exec -T "$db_container_service" psql -U merchant -d "$restore_db" -Atc 'SELECT string_agg(version::text, '"'"','"'"' ORDER BY version) FROM schema_migrations')
expected_schema_versions=$(find packages/persistence/src/migrations -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | awk -F_ '{printf "%d\n", $1}' | sort -n | paste -sd, -)
test "$schema_versions" = "$expected_schema_versions"
business_tables=$(docker compose -f "$compose_file" exec -T "$db_container_service" psql -U merchant -d "$restore_db" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('products','tasks','content_versions','publish_jobs','generation_jobs','business_entity_snapshots')")
test "$business_tables" = 6
echo "{\"profile\":\"local_backup_restore\",\"migrationVersions\":\"$schema_versions\",\"businessTables\":$business_tables,\"cloudGate\":false,\"status\":\"pass\"}"
