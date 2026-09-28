import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { reviewDemo254BackupSource } from '../infra/protected/review-demo-254-backup-source.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const id = char => char.repeat(64)
const image = char => `sha256:${id(char)}`
const migrations = Array.from({ length: 254 }, (_, index) => ({ version: index + 1, name: `migration_${index + 1}`, checksum: sha(`sql-${index + 1}`) }))
const historySha = rows => sha(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))
const now = new Date('2026-09-28T04:00:00.000Z')

function fixture() {
  const publicRoute = { origin: 'https://yxsona.com', host: 'yxsona.com', path_prefix: '/api',
    release_id: 'release-f48c8454-dual-e2e', git_sha: 'f48c84544c519642de7c92615351007c9ac70a99',
    gateway_id: id('a'), api_replica_id: id('b') }
  const gateway = { id: id('a'), image_id: image('a'), route_host: 'yxsona.com', route_path_prefix: '/api',
    upstream_container_id: id('b'), upstream_port: 8787 }
  const apiReplica = { id: id('b'), image_id: image('b'), compose_project: 'merchant-demo-85575f9c',
    compose_service: 'api-replica', network_name: 'merchant-demo-85575f9c_default', network_id: id('c'),
    postgres_container_id: '6abd0fb584b3746cca5b3e73d21681a24ab3780fce0a46d385ffcebcd43c0980' }
  const postgres = { id: apiReplica.postgres_container_id, image_id: image('d'),
    compose_project: 'merchant-demo-85575f9c', compose_service: 'postgres',
    network_name: 'merchant-demo-85575f9c_default', network_id: id('c'), ipv4: '192.168.96.3',
    volume_name: 'merchant-demo-85575f9c_merchant-postgres' }
  const connections = {
    runtime: { host: 'postgres', resolved_ip: postgres.ipv4, port: 5432, database: 'merchant', user: 'merchant_app' },
    ops: { host: 'postgres', resolved_ip: postgres.ipv4, port: 5432, database: 'merchant', user: 'merchant_ops' },
  }
  const frozen = { schema_version: 'demo-254-backup-source-freeze/1', public_route: publicRoute,
    gateway, api_replica: apiReplica, postgres, connections,
    database: { name: 'merchant', oid: 16384, system_identifier_sha256: sha('7456012345678901234'),
      server_version_num: 160015, history_sha256: historySha(migrations) }, candidate_migrations: migrations }
  const observed = { schema_version: 'demo-254-backup-source-observation/1', observed_at: '2026-09-28T03:59:00.000Z',
    public_route: structuredClone(publicRoute), gateway: structuredClone(gateway),
    api_replica: structuredClone(apiReplica), postgres: structuredClone(postgres), connections: structuredClone(connections),
    database: { name: 'merchant', oid: 16384, system_identifier: '7456012345678901234',
      server_version_num: 160015, migration_rows: structuredClone(migrations) } }
  return { frozen, observed, now }
}

test('binds public gateway to api-replica, both database roles, and the candidate 254 migration chain without authorizing backup', () => {
  const result = reviewDemo254BackupSource(fixture())
  assert.deepEqual(result, { schema_version: 'demo-254-backup-source-review/1', status: 'review_only_match',
    frozen_sha256: result.frozen_sha256, observation_sha256: result.observation_sha256,
    source_database_id_sha256: sha('7456012345678901234'), migration_history_sha256: historySha(migrations),
    backup_authorized: false, deploy_authorized: false, source_provenance_verified: false })
  assert.match(result.frozen_sha256, /^[a-f0-9]{64}$/u)
  assert.match(result.observation_sha256, /^[a-f0-9]{64}$/u)
})

test('rejects the legacy merchant-production PostgreSQL source and its 242 prefix', () => {
  const source = fixture()
  source.observed.postgres.compose_project = 'merchant-production'
  assert.throws(() => reviewDemo254BackupSource(source), /DEMO_254_SOURCE_/u)
  const legacy = fixture()
  legacy.frozen.postgres.compose_project = 'merchant-production'
  legacy.observed.postgres.compose_project = 'merchant-production'
  assert.throws(() => reviewDemo254BackupSource(legacy), /DEMO_254_SOURCE_POSTGRES_TOPOLOGY_INVALID/u)
  const short = fixture()
  short.observed.database.migration_rows.length = 242
  assert.throws(() => reviewDemo254BackupSource(short), /PREFIX_NOT_254/u)
})

test('rejects a gateway routed to api instead of api-replica, wrong host, and route drift', () => {
  for (const mutate of [
    input => { input.observed.gateway.upstream_container_id = id('e') },
    input => { input.frozen.gateway.upstream_container_id = id('e'); input.observed.gateway.upstream_container_id = id('e') },
    input => { input.observed.public_route.host = 'ops.yxsona.com' },
    input => { input.observed.gateway.route_path_prefix = '/' },
    input => { input.observed.api_replica.compose_service = 'api' },
  ]) {
    const input = fixture(); mutate(input)
    assert.throws(() => reviewDemo254BackupSource(input), /DEMO_254_SOURCE_/u)
  }
})

test('rejects database endpoint, role, network, volume and cluster identity drift', () => {
  for (const mutate of [
    input => { input.observed.connections.runtime.resolved_ip = '172.29.0.2' },
    input => { input.frozen.connections.ops.user = 'postgres'; input.observed.connections.ops.user = 'postgres' },
    input => { input.frozen.connections.runtime.host = 'db.internal'; input.observed.connections.runtime.host = 'db.internal' },
    input => { input.observed.connections.ops.host = 'legacy-postgres' },
    input => { input.observed.api_replica.network_id = id('e') },
    input => { input.observed.postgres.volume_name = 'merchant-production_merchant-postgres' },
    input => { input.observed.database.system_identifier = '7456012345678901235' },
    input => { input.observed.database.oid = 999 },
    input => { input.frozen.postgres.ipv4 = '999.168.96.3'; input.observed.postgres.ipv4 = '999.168.96.3'; input.frozen.connections.runtime.resolved_ip = '999.168.96.3'; input.observed.connections.runtime.resolved_ip = '999.168.96.3'; input.frozen.connections.ops.resolved_ip = '999.168.96.3'; input.observed.connections.ops.resolved_ip = '999.168.96.3' },
  ]) {
    const input = fixture(); mutate(input)
    assert.throws(() => reviewDemo254BackupSource(input), /DEMO_254_SOURCE_/u)
  }
})

test('requires candidate SQL names and checksums, not merely a self-consistent database rowset', () => {
  const input = fixture()
  input.observed.database.migration_rows[253].checksum = sha('tampered-sql')
  assert.throws(() => reviewDemo254BackupSource(input), /MIGRATION_HISTORY_DRIFT/u)
  const forged = fixture()
  forged.observed.database.migration_rows[253].checksum = sha('tampered-sql')
  forged.frozen.database.history_sha256 = historySha(forged.observed.database.migration_rows)
  assert.throws(() => reviewDemo254BackupSource(forged), /MIGRATION_HISTORY_DRIFT/u)
  const renamed = fixture()
  renamed.observed.database.migration_rows[253].name = 'different_255'
  assert.throws(() => reviewDemo254BackupSource(renamed), /MIGRATION_HISTORY_DRIFT/u)
})

test('fails on stale capture and disallows secret or unbound input fields', () => {
  const stale = fixture()
  stale.observed.observed_at = '2026-09-28T03:54:00.000Z'
  assert.throws(() => reviewDemo254BackupSource(stale), /OBSERVATION_STALE/u)
  const secret = fixture()
  secret.observed.connections.runtime.password = 'must-never-enter-review'
  assert.throws(() => reviewDemo254BackupSource(secret), /SHAPE_INVALID/u)
  const unexpected = fixture()
  unexpected.observed.backup_path = '/tmp/fake.dump'
  assert.throws(() => reviewDemo254BackupSource(unexpected), /SHAPE_INVALID/u)
})
