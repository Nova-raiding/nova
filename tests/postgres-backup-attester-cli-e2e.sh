#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
suffix="${PPID}-$$"
pg_container="backup-attester-cli-pg16-${suffix}"
node_container="backup-attester-cli-node22-${suffix}"
pg_image='postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
node_image='node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
scratch=$(mktemp -d)

cleanup() {
  docker rm -f "$pg_container" "$node_container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
inside() { docker exec "$pg_container" "$@"; }

docker image inspect "$pg_image" >/dev/null
docker image inspect "$node_image" >/dev/null
docker run -d --network none --name "$pg_container" -e POSTGRES_HOST_AUTH_METHOD=trust "$pg_image" >/dev/null
docker create --network none --name "$node_container" "$node_image" >/dev/null

for _ in $(seq 1 30); do
  inside pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
inside pg_isready -U postgres >/dev/null 2>&1 || fail 'isolated PostgreSQL did not become ready'

# docker cp is intentional: Colima does not expose host /tmp bind mounts reliably.
docker cp "$node_container:/usr/local/bin/node" "$scratch/node"
docker cp -L "$node_container:/usr/lib/libstdc++.so.6" "$scratch/libstdc++.so.6"
docker cp -L "$node_container:/usr/lib/libgcc_s.so.1" "$scratch/libgcc_s.so.1"
inside mkdir -p \
  /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin \
  /usr/pgsql-16/bin \
  /run/release-security/evidence-trust \
  /var/lib/merchant-release-security/backups/e2e
docker cp "$scratch/node" "$pg_container:/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node"
docker cp "$scratch/libstdc++.so.6" "$pg_container:/usr/lib/libstdc++.so.6"
docker cp "$scratch/libgcc_s.so.1" "$pg_container:/usr/lib/libgcc_s.so.1"
docker cp "$root/infra/protected/attest-postgres-backup.mjs" "$pg_container:/usr/local/libexec/merchant/attest-postgres-backup"
inside cp /usr/local/bin/psql /usr/pgsql-16/bin/psql
inside cp /usr/local/bin/pg_dump /usr/pgsql-16/bin/pg_dump
inside chown -R root:root /usr/local/libexec/merchant /usr/pgsql-16 /run/release-security /var/lib/merchant-release-security
inside chmod 0755 \
  /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /usr/local/libexec/merchant/attest-postgres-backup \
  /usr/pgsql-16/bin/psql /usr/pgsql-16/bin/pg_dump
inside chmod 0700 /var/lib/merchant-release-security /var/lib/merchant-release-security/backups /var/lib/merchant-release-security/backups/e2e

docker exec -i "$pg_container" psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.schema_migrations(version bigint PRIMARY KEY);
INSERT INTO public.schema_migrations VALUES (233);
CREATE TABLE public.zz_snapshot_probe(id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO public.zz_snapshot_probe VALUES (1, 'before');
CREATE TABLE public.aa_dump_padding AS
  SELECT value AS id, repeat(md5(value::text), 8) AS payload
  FROM generate_series(1, 500000) AS value;
SQL

system_identifier=$(inside psql -U postgres -At -c 'SELECT system_identifier FROM pg_control_system()')
database_oid=$(inside psql -U postgres -At -c "SELECT oid FROM pg_database WHERE datname=current_database()")
database_name=$(inside psql -U postgres -At -c 'SELECT current_database()')
docker exec -i "$pg_container" env SYSTEM_IDENTIFIER="$system_identifier" DATABASE_OID="$database_oid" DATABASE_NAME="$database_name" \
  /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node - <<'NODE'
const { createHash, generateKeyPairSync } = require('node:crypto')
const { writeFileSync } = require('node:fs')
const pair = generateKeyPairSync('ed25519')
writeFileSync('/var/lib/merchant-release-security/production-capability-private.pem', pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
writeFileSync('/run/release-security/evidence-trust/production-evidence-public.pem', pair.publicKey.export({ format: 'pem', type: 'spki' }), { mode: 0o644 })
writeFileSync('/run/release-security/evidence-trust/production-evidence-key-id', 'synthetic-cli-e2e\n', { mode: 0o644 })
const policy = {
  system_identifier_sha256: createHash('sha256').update(process.env.SYSTEM_IDENTIFIER).digest('hex'),
  database_oid: Number(process.env.DATABASE_OID),
  database_name: process.env.DATABASE_NAME,
}
writeFileSync('/run/release-security/evidence-trust/production-backup-source-release-synthetic-cli-e2e.json', JSON.stringify(policy) + '\n', { mode: 0o444 })
NODE
inside sh -c "sha256sum /usr/local/libexec/merchant/attest-postgres-backup | awk '{print \$1}' > /run/release-security/evidence-trust/production-backup-attester-sha256"
inside chown root:root \
  /var/lib/merchant-release-security/production-capability-private.pem \
  /run/release-security/evidence-trust/production-evidence-public.pem \
  /run/release-security/evidence-trust/production-evidence-key-id \
  /run/release-security/evidence-trust/production-backup-source-release-synthetic-cli-e2e.json \
  /run/release-security/evidence-trust/production-backup-attester-sha256
inside chmod 0600 /var/lib/merchant-release-security/production-capability-private.pem
inside sh -c 'chmod 0644 /run/release-security/evidence-trust/*'
source_policy=/run/release-security/evidence-trust/production-backup-source-release-synthetic-cli-e2e.json
inside chmod 0444 "$source_policy"

backup=/var/lib/merchant-release-security/backups/e2e/merchant.dump
checksum=${backup}.sha256
attestation=/var/lib/merchant-release-security/backups/e2e/merchant.attestation.json
docker exec "$pg_container" env NODE_ENV=production PGHOST=/var/run/postgresql PGDATABASE=postgres PGUSER=postgres \
  /usr/local/libexec/merchant/attest-postgres-backup create \
  --backup "$backup" --checksum "$checksum" --attestation "$attestation" --source-policy "$source_policy" >"$scratch/cli.out" 2>"$scratch/cli.err" &
cli_pid=$!

observed_snapshot=0
for _ in $(seq 1 500); do
  if [ "$(inside psql -U postgres -At -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='pg_dump' AND backend_xmin IS NOT NULL")" -gt 0 ]; then
    observed_snapshot=1
    break
  fi
  kill -0 "$cli_pid" >/dev/null 2>&1 || break
  sleep 0.01
done
[ "$observed_snapshot" -eq 1 ] || { wait "$cli_pid" || true; fail "did not observe pg_dump holding the exported snapshot: $(cat "$scratch/cli.err")"; }
inside psql -U postgres -v ON_ERROR_STOP=1 -c "UPDATE public.zz_snapshot_probe SET value='after' WHERE id=1" >/dev/null
wait "$cli_pid" || fail "full CLI failed: $(cat "$scratch/cli.err")"
inside sha256sum -c "$checksum" >/dev/null || fail 'fresh backup checksum was rejected'
docker exec -i "$pg_container" env ATTESTATION_PATH="$attestation" /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node - <<'NODE'
const { readFileSync } = require('node:fs')
const value = JSON.parse(readFileSync(process.env.ATTESTATION_PATH, 'utf8'))
const started = Date.parse(value.backup_started_at)
const observed = Date.parse(value.snapshot_export_observed_at)
const completed = Date.parse(value.dump_completed_at)
if (value.schema_version !== '2' || !/^[a-f0-9]{64}$/.test(value.snapshot_id_sha256) ||
    !Number.isFinite(started) || !Number.isFinite(observed) || !Number.isFinite(completed) ||
    value.created_at !== value.backup_started_at || !(started <= observed && observed <= completed)) {
  throw new Error('protected backup did not attest the real snapshot/dump chronology')
}
NODE

inside createdb -U postgres restored_e2e
inside pg_restore -U postgres -d restored_e2e --no-owner --no-privileges "$backup"
restored_value=$(inside psql -U postgres -d restored_e2e -At -c 'SELECT value FROM public.zz_snapshot_probe WHERE id=1')
[ "$restored_value" = before ] || fail "snapshot was inconsistent: restored value=$restored_value"

inside cp "$source_policy" /run/release-security/evidence-trust/source-policy.good
docker exec -i "$pg_container" /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node - <<'NODE'
const fs = require('node:fs')
const path = '/run/release-security/evidence-trust/production-backup-source-release-synthetic-cli-e2e.json'
const policy = JSON.parse(fs.readFileSync(path, 'utf8'))
policy.database_oid += 1
fs.writeFileSync(path, JSON.stringify(policy) + '\n', { mode: 0o644 })
NODE
if inside env NODE_ENV=production PGHOST=/var/run/postgresql PGDATABASE=postgres PGUSER=postgres \
  /usr/local/libexec/merchant/attest-postgres-backup create \
  --backup /var/lib/merchant-release-security/backups/e2e/wrong-oid.dump \
  --checksum /var/lib/merchant-release-security/backups/e2e/wrong-oid.sha256 \
  --attestation /var/lib/merchant-release-security/backups/e2e/wrong-oid.json \
  --source-policy "$source_policy" >"$scratch/oid.out" 2>"$scratch/oid.err"; then
  fail 'wrong database OID was accepted'
fi
grep -q 'database OID does not match protected source policy' "$scratch/oid.err" || fail 'wrong OID rejection reason was not preserved'
inside test ! -e /var/lib/merchant-release-security/backups/e2e/wrong-oid.dump || fail 'wrong OID produced a backup'
inside mv /run/release-security/evidence-trust/source-policy.good "$source_policy"
inside chmod 0444 "$source_policy"

if inside env NODE_ENV=production PGHOST=/var/run/postgresql PGDATABASE=postgres PGUSER=postgres \
  /usr/local/libexec/merchant/attest-postgres-backup create \
  --backup /root/outside.dump --checksum /root/outside.sha256 --attestation /root/outside.json \
  --source-policy "$source_policy" >"$scratch/path.out" 2>"$scratch/path.err"; then
  fail 'out-of-root output was accepted'
fi
grep -q 'output must be inside the protected backup root' "$scratch/path.err" || fail 'output boundary rejection reason was not preserved'
inside test ! -e /root/outside.dump || fail 'out-of-root backup was created'

inside cp "$checksum" /run/release-security/evidence-trust/checksum.good
docker exec -i "$pg_container" env CHECKSUM_PATH="$checksum" /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node - <<'NODE'
const fs = require('node:fs')
const value = fs.readFileSync(process.env.CHECKSUM_PATH, 'utf8')
fs.writeFileSync(process.env.CHECKSUM_PATH, `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`)
NODE
if inside sha256sum -c "$checksum" >/dev/null 2>&1; then fail 'tampered checksum was accepted'; fi
inside mv /run/release-security/evidence-trust/checksum.good "$checksum"
inside sha256sum -c "$checksum" >/dev/null || fail 'restored checksum sidecar was rejected'

printf 'PASS: full protected CLI snapshot/dump/restore and rejection matrix\n'
printf '  postgres=%s node=%s restored_value=%s migration=233\n' \
  "$(inside pg_dump --version)" "$(inside /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node --version)" "$restored_value"
