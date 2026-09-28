// Review-only binding for the current demo PostgreSQL source. The protected
// caller must independently authenticate the frozen plan and collect every
// observation from Docker, the public route and read-only PostgreSQL queries.
// This module cannot authorize a backup, sign evidence or access credentials.
import { createHash } from 'node:crypto'

const PROJECT = 'merchant-demo-85575f9c'
const NETWORK = `${PROJECT}_default`
const VOLUME = `${PROJECT}_merchant-postgres`
const SHA = /^[a-f0-9]{64}$/u
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u
const CONTAINER_ID = /^[a-f0-9]{64}$/u
const fail = message => { throw new Error(`DEMO_254_SOURCE_${message}`) }
const check = (condition, message) => { if (!condition) fail(message) }
const sha = value => createHash('sha256').update(value).digest('hex')
const validIpv4 = value => typeof value === 'string' && value.split('.').length === 4
  && value.split('.').every(part => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)

function exact(value, keys, label) {
  check(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label}_SHAPE_INVALID`)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function historyDigest(rows, label) {
  check(Array.isArray(rows) && rows.length === 254, `${label}_PREFIX_NOT_254`)
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    exact(row, ['version', 'name', 'checksum'], `${label}_ROW`)
    check(row.version === index + 1 && /^[a-z0-9][a-z0-9_]*$/u.test(row.name)
      && SHA.test(row.checksum), `${label}_ROW_INVALID`)
  }
  return sha(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))
}

function compareExact(expected, actual, keys, label) {
  exact(expected, keys, `FROZEN_${label}`)
  exact(actual, keys, `OBSERVED_${label}`)
  for (const key of keys) check(actual[key] === expected[key], `${label}_${key.toUpperCase()}_DRIFT`)
}

function validateTopology(frozen, observed) {
  const publicKeys = ['origin', 'host', 'path_prefix', 'release_id', 'git_sha', 'gateway_id', 'api_replica_id']
  compareExact(frozen.public_route, observed.public_route, publicKeys, 'PUBLIC_ROUTE')
  check(frozen.public_route.origin === 'https://yxsona.com' && frozen.public_route.host === 'yxsona.com'
    && frozen.public_route.path_prefix === '/api' && /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(frozen.public_route.release_id)
    && /^[a-f0-9]{40}$/u.test(frozen.public_route.git_sha), 'PUBLIC_ROUTE_INVALID')

  const gatewayKeys = ['id', 'image_id', 'route_host', 'route_path_prefix', 'upstream_container_id', 'upstream_port']
  compareExact(frozen.gateway, observed.gateway, gatewayKeys, 'GATEWAY')
  check(CONTAINER_ID.test(frozen.gateway.id) && IMAGE_ID.test(frozen.gateway.image_id)
    && frozen.gateway.id === frozen.public_route.gateway_id
    && frozen.gateway.route_host === frozen.public_route.host
    && frozen.gateway.route_path_prefix === '/api'
    && frozen.gateway.upstream_container_id === frozen.public_route.api_replica_id
    && frozen.gateway.upstream_port === 8787, 'GATEWAY_ROUTE_INVALID')

  const apiKeys = ['id', 'image_id', 'compose_project', 'compose_service', 'network_name', 'network_id', 'postgres_container_id']
  compareExact(frozen.api_replica, observed.api_replica, apiKeys, 'API_REPLICA')
  check(CONTAINER_ID.test(frozen.api_replica.id) && IMAGE_ID.test(frozen.api_replica.image_id)
    && frozen.api_replica.id === frozen.public_route.api_replica_id
    && frozen.api_replica.compose_project === PROJECT && frozen.api_replica.compose_service === 'api-replica'
    && frozen.api_replica.network_name === NETWORK && CONTAINER_ID.test(frozen.api_replica.network_id), 'API_REPLICA_INVALID')

  const postgresKeys = ['id', 'image_id', 'compose_project', 'compose_service', 'network_name', 'network_id', 'ipv4', 'volume_name']
  compareExact(frozen.postgres, observed.postgres, postgresKeys, 'POSTGRES')
  check(CONTAINER_ID.test(frozen.postgres.id) && IMAGE_ID.test(frozen.postgres.image_id)
    && frozen.postgres.compose_project === PROJECT && frozen.postgres.compose_service === 'postgres'
    && frozen.postgres.network_name === NETWORK && CONTAINER_ID.test(frozen.postgres.network_id)
    && frozen.postgres.network_id === frozen.api_replica.network_id
    && validIpv4(frozen.postgres.ipv4) && frozen.postgres.volume_name === VOLUME
    && frozen.api_replica.postgres_container_id === frozen.postgres.id, 'POSTGRES_TOPOLOGY_INVALID')

  exact(frozen.connections, ['runtime', 'ops'], 'FROZEN_CONNECTIONS')
  exact(observed.connections, ['runtime', 'ops'], 'OBSERVED_CONNECTIONS')
  const connectionKeys = ['host', 'resolved_ip', 'port', 'database', 'user']
  for (const [kind, role] of [['runtime', 'merchant_app'], ['ops', 'merchant_ops']]) {
    compareExact(frozen.connections[kind], observed.connections[kind], connectionKeys, `${kind.toUpperCase()}_CONNECTION`)
    const connection = frozen.connections[kind]
    check(connection.host === 'postgres'
      && connection.resolved_ip === frozen.postgres.ipv4 && connection.port === 5432
      && connection.database === 'merchant' && connection.user === role, `${kind.toUpperCase()}_ENDPOINT_INVALID`)
  }
}

/**
 * Compare one frozen, externally authenticated source plan with a fresh
 * observation. Passing here is a consistency result, never production proof.
 */
export function reviewDemo254BackupSource({ frozen, observed, now = new Date() }) {
  exact(frozen, ['schema_version', 'public_route', 'gateway', 'api_replica', 'postgres', 'connections', 'database', 'candidate_migrations'], 'FROZEN')
  exact(observed, ['schema_version', 'observed_at', 'public_route', 'gateway', 'api_replica', 'postgres', 'connections', 'database'], 'OBSERVED')
  check(frozen.schema_version === 'demo-254-backup-source-freeze/1'
    && observed.schema_version === 'demo-254-backup-source-observation/1', 'SCHEMA_INVALID')
  check(now instanceof Date && Number.isFinite(now.getTime())
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(observed.observed_at)
    && Date.parse(observed.observed_at) <= now.getTime()
    && now.getTime() - Date.parse(observed.observed_at) <= 5 * 60_000, 'OBSERVATION_STALE')
  validateTopology(frozen, observed)

  exact(frozen.database, ['name', 'oid', 'system_identifier_sha256', 'server_version_num', 'history_sha256'], 'FROZEN_DATABASE')
  exact(observed.database, ['name', 'oid', 'system_identifier', 'server_version_num', 'migration_rows'], 'OBSERVED_DATABASE')
  check(frozen.database.name === 'merchant' && frozen.database.oid > 0 && Number.isSafeInteger(frozen.database.oid)
    && SHA.test(frozen.database.system_identifier_sha256) && SHA.test(frozen.database.history_sha256)
    && Number.isSafeInteger(frozen.database.server_version_num)
    && frozen.database.server_version_num >= 160000 && frozen.database.server_version_num < 170000,
  'DATABASE_SOURCE_INVALID')
  check(observed.database.name === frozen.database.name && observed.database.oid === frozen.database.oid
    && observed.database.server_version_num === frozen.database.server_version_num
    && /^\d{1,32}$/u.test(observed.database.system_identifier)
    && sha(observed.database.system_identifier) === frozen.database.system_identifier_sha256,
  'DATABASE_IDENTITY_DRIFT')
  const candidateHistorySha256 = historyDigest(frozen.candidate_migrations, 'CANDIDATE')
  const observedHistorySha256 = historyDigest(observed.database.migration_rows, 'OBSERVED')
  check(candidateHistorySha256 === frozen.database.history_sha256
    && observedHistorySha256 === candidateHistorySha256
    && observed.database.migration_rows.every((row, index) => row.name === frozen.candidate_migrations[index].name
      && row.checksum === frozen.candidate_migrations[index].checksum), 'MIGRATION_HISTORY_DRIFT')

  return Object.freeze({ schema_version: 'demo-254-backup-source-review/1', status: 'review_only_match',
    frozen_sha256: sha(canonical(frozen)), observation_sha256: sha(canonical(observed)),
    source_database_id_sha256: frozen.database.system_identifier_sha256,
    migration_history_sha256: candidateHistorySha256,
    backup_authorized: false, deploy_authorized: false, source_provenance_verified: false })
}
