#!/bin/sh
set -eu

command -v docker >/dev/null 2>&1 || { echo 'docker is required for disposable PostgreSQL ACL tests' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/.." && pwd)
run_id=$(date +%s)-$$
capture_sql=''

for major in 16 17; do
  container="canonical-acl-pg${major}-${run_id}"
  cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    if [ -n "$capture_sql" ]; then rm -f "$capture_sql"; fi
  }
  trap cleanup EXIT INT TERM
  docker run --rm -d --name "$container" -e POSTGRES_PASSWORD=ephemeral -e POSTGRES_HOST_AUTH_METHOD=trust "postgres:${major}-alpine" >/dev/null
  i=0
  until docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 60 ] || { echo "PostgreSQL ${major} did not become ready" >&2; exit 1; }
    sleep 1
  done

  docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
CREATE TABLE public.workspaces(id text PRIMARY KEY, status text NOT NULL);
CREATE TABLE public.platform_feature_flags(id bigserial PRIMARY KEY, flag_key text NOT NULL, environment text NOT NULL, value_type text NOT NULL, value_json jsonb, enabled boolean NOT NULL, emergency_disabled boolean NOT NULL, valid_from timestamptz, valid_to timestamptz, revision integer NOT NULL);
CREATE TABLE public.platform_feature_flag_targets(id bigserial PRIMARY KEY, flag_id bigint REFERENCES public.platform_feature_flags(id), target_type text NOT NULL, target_value text NOT NULL, enabled boolean NOT NULL, value_json jsonb);
CREATE TABLE public.safe_state_unrelated(secret text NOT NULL);
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
INSERT INTO public.workspaces VALUES ('ws-a', 'active');
INSERT INTO public.platform_feature_flags(flag_key, environment, value_type, value_json, enabled, emergency_disabled, revision) VALUES ('canonical.product.read_mode', 'production', 'string', '"legacy_shadow"', true, false, 1);
SQL

  docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
GRANT UPDATE(id) ON public.workspaces TO PUBLIC;
SQL
  if docker cp "$repo/infra/protected/canonical-safe-state-reader-bootstrap.sql" "$container:/tmp/bootstrap.sql" >/dev/null 2>&1 && docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null 2>&1; then
    echo "PostgreSQL ${major}: bootstrap accepted PUBLIC column UPDATE on a source table" >&2
    exit 1
  fi
  docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'REVOKE UPDATE(id) ON public.workspaces FROM PUBLIC' >/dev/null

  docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
GRANT SELECT(secret) ON public.safe_state_unrelated TO PUBLIC;
SQL
  if docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null 2>&1; then
    echo "PostgreSQL ${major}: bootstrap accepted PUBLIC column SELECT on an unrelated relation" >&2
    exit 1
  fi
  docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'REVOKE SELECT(secret) ON public.safe_state_unrelated FROM PUBLIC' >/dev/null
  docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null

  docker cp "$repo/infra/scripts/verify-canonical-safe-state-reader.sh" "$container:/tmp/verify-reader.sh" >/dev/null
  docker exec "$container" sh -eu -c 'printf "[localreader]\nhost=/var/run/postgresql\ndbname=postgres\nuser=canonical_safe_state_reader\n" > /tmp/reader.pg_service; chmod 600 /tmp/reader.pg_service'
  docker exec "$container" env PGSERVICEFILE=/tmp/reader.pg_service CANONICAL_SAFE_STATE_PGSERVICE=localreader sh /tmp/verify-reader.sh >/dev/null

  capture_sql="/tmp/canonical-safe-state-capture-${major}-${run_id}.sql"
  node --input-type=module -e "import {writeFileSync} from 'node:fs'; import {CAPTURE_SQL} from '$repo/infra/protected/canonical-safe-state-snapshot.mjs'; writeFileSync('$capture_sql', 'SET SESSION AUTHORIZATION canonical_safe_state_reader;\\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\\n'+CAPTURE_SQL)"
  docker cp "$capture_sql" "$container:/tmp/capture.sql" >/dev/null
  capture_output=$(docker exec "$container" psql -U postgres -d postgres -X -qAt -v ON_ERROR_STOP=1 -f /tmp/capture.sql)
  printf '%s' "$capture_output" | node --input-type=module -e 'let raw=""; for await (const chunk of process.stdin) raw += chunk; const snapshot=JSON.parse(raw); if (!/^\d{1,20}$/.test(snapshot.system_identifier ?? "")) throw new Error("read-only collector omitted PostgreSQL cluster system identifier"); if (!/^\d+$/.test(snapshot.database_oid ?? "")) throw new Error("read-only collector omitted database OID")'

  docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'GRANT UPDATE(status) ON public.workspaces TO canonical_safe_state_reader' >/dev/null
  if docker exec "$container" env PGSERVICEFILE=/tmp/reader.pg_service CANONICAL_SAFE_STATE_PGSERVICE=localreader sh /tmp/verify-reader.sh >/dev/null 2>&1; then
    echo "PostgreSQL ${major}: verifier accepted reader column UPDATE on a source table" >&2
    exit 1
  fi
  if docker exec "$container" psql -U postgres -d postgres -X -qAt -v ON_ERROR_STOP=1 -f /tmp/capture.sql >/dev/null 2>&1; then
    echo "PostgreSQL ${major}: collector guard accepted reader column UPDATE on a source table" >&2
    exit 1
  fi
  docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'REVOKE UPDATE(status) ON public.workspaces FROM canonical_safe_state_reader' >/dev/null

  docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'GRANT SELECT(secret) ON public.safe_state_unrelated TO canonical_safe_state_reader' >/dev/null
  if docker exec "$container" env PGSERVICEFILE=/tmp/reader.pg_service CANONICAL_SAFE_STATE_PGSERVICE=localreader sh /tmp/verify-reader.sh >/dev/null 2>&1; then
    echo "PostgreSQL ${major}: verifier accepted reader column SELECT on unrelated relation" >&2
    exit 1
  fi
  if docker exec "$container" psql -U postgres -d postgres -X -qAt -v ON_ERROR_STOP=1 -f /tmp/capture.sql >/dev/null 2>&1; then
    echo "PostgreSQL ${major}: collector guard accepted reader column SELECT on unrelated relation" >&2
    exit 1
  fi
  cleanup
  trap - EXIT INT TERM
  capture_sql=''
  echo "PostgreSQL ${major}: column ACL bootstrap, verifier and collector attack cases passed"
done
