import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BRIDGE_254_CLUSTER_SQL, BRIDGE_254_OBSERVE_SQL, bridge254DatabaseEnvironment,
  verifyBridge254DatabaseIdentityPolicy,
  openProductionBridge254RuntimeObserver, verifyBridge254ObservedHistories } from '../infra/protected/ecs-bridge-254-runtime-observer.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const policy = { hostname: 'db.example', port: 5432, database_name: 'merchant', database_oid: 16384,
  system_identifier_sha256: sha('7456012345678901234'), ca_file: '/protected/pg-ca.pem', ca_sha256: sha('ca') }
const cluster = { system_identifier: '7456012345678901234', database_oid: 16384,
  database_name: 'merchant', server_addr: '192.0.2.10', server_port: 5432 }
const history = Array.from({ length: 254 }, (_, i) => [i + 1, `migration_${i + 1}`, sha(`sql-${i + 1}`)])
const prefixes = Object.fromEntries(Array.from({ length: 13 }, (_, i) => {
  const version = 242 + i
  return [String(version), sha(history.slice(0, version).map(([n, name, checksum]) => `${n}\t${name}\t${checksum}\n`).join(''))]
}))
const observe = version => ({ history: history.slice(0, version), invalid_indexes: [],
  database_oid: 16384, database_name: 'merchant', server_addr: '192.0.2.10', server_port: 5432 })

test('returns exact matching runtime and ops history for each approved prefix', () => {
  for (let version = 242; version <= 254; version += 1) {
    assert.deepEqual(verifyBridge254ObservedHistories(observe(version), observe(version), cluster, prefixes, policy), {
      version, history_sha256: prefixes[version], ops_version: version, ops_history_sha256: prefixes[version],
    })
  }
})

test('fails closed on gaps, duplicate/mismatched checksums, drift, invalid indexes and unknown prefix', () => {
  for (const [runtime, ops, plan] of [
    [observe(241), observe(241), prefixes],
    [{ ...observe(254), history: [...history, [255, 'migration_255', sha('sql-255')]] }, observe(254), prefixes],
    [{ ...observe(243), history: [...history.slice(0, 242), history[241]] }, observe(243), prefixes],
    [{ ...observe(242), history: history.slice(0, 242).map((row, i) => i === 30 ? [99, row[1], row[2]] : row) }, observe(242), prefixes],
    [{ ...observe(242), history: history.slice(0, 242).map((row, i) => i === 30 ? [row[0], row[1], 'f'.repeat(64)] : row) }, observe(242), prefixes],
    [observe(242), observe(243), prefixes],
    [{ ...observe(242), invalid_indexes: ['unsafe_idx'] }, observe(242), prefixes],
    [observe(242), observe(242), { ...prefixes, 242: 'f'.repeat(64) }],
    [observe(242), observe(242), { 242: prefixes[242] }],
  ]) assert.throws(() => verifyBridge254ObservedHistories(runtime, ops, cluster, plan, policy), /BRIDGE_254_OBSERVER_/u)
})

test('requires independently pinned host, port, database and verify-full CA for all roles', () => {
  const url = (role, host = 'db.example', query = 'sslmode=verify-full&sslrootcert=%2Fprotected%2Fpg-ca.pem') =>
    `postgres://${role}:private@${host}:5432/merchant?${query}`
  const app = bridge254DatabaseEnvironment(url('merchant_app'), 'merchant_app', policy)
  assert.equal(app.PGUSER, 'merchant_app')
  assert.equal(app.PGSSLMODE, 'verify-full')
  assert.equal(app.PGSSLROOTCERT, policy.ca_file)
  assert.match(app.PGOPTIONS, /default_transaction_read_only=on/u)
  assert.doesNotMatch(JSON.stringify({ ...app, PGPASSWORD: undefined }), /private/u)
  for (const candidateUrl of [
    url('merchant_ops'), url('merchant_app', 'other.example'),
    url('merchant_app', 'db.example', 'sslmode=require&sslrootcert=%2Fprotected%2Fpg-ca.pem'),
    url('merchant_app', 'db.example', 'sslmode=verify-ca&sslrootcert=%2Fprotected%2Fpg-ca.pem'),
    url('merchant_app', 'db.example', 'sslmode=verify-full&sslrootcert=%2Fwrong.pem'),
    url('merchant_app', 'db.example', 'sslmode=verify-full&sslrootcert=%2Fprotected%2Fpg-ca.pem&options=-c'),
    'postgres://merchant_app:private@db.example:5433/merchant?sslmode=verify-full&sslrootcert=%2Fprotected%2Fpg-ca.pem',
    'postgres://merchant_app:private@db.example:5432/other?sslmode=verify-full&sslrootcert=%2Fprotected%2Fpg-ca.pem',
  ]) assert.throws(() => bridge254DatabaseEnvironment(candidateUrl, 'merchant_app', policy), /BRIDGE_254_OBSERVER_/u)
  assert.throws(() => bridge254DatabaseEnvironment(url('merchant_app'), 'merchant_app'), /DATABASE_IDENTITY_POLICY_INVALID/u)
  assert.throws(() => verifyBridge254DatabaseIdentityPolicy({ ...policy, hostname: 'localhost' }), /DATABASE_IDENTITY_POLICY_INVALID/u)
  assert.throws(() => openProductionBridge254RuntimeObserver({ frozenPrefixes: prefixes }), /BRIDGE_254_OBSERVER_|ENOENT/u)
})

test('rejects wrong cluster identifier, database OID or split endpoints', () => {
  for (const [runtime, ops, observedCluster] of [
    [observe(242), observe(242), { ...cluster, system_identifier: '7456012345678901235' }],
    [{ ...observe(242), database_oid: 99 }, observe(242), cluster],
    [observe(242), { ...observe(242), server_addr: '192.0.2.11' }, cluster],
    [observe(242), observe(242), { ...cluster, server_addr: '192.0.2.11' }],
  ]) assert.throws(() => verifyBridge254ObservedHistories(runtime, ops, observedCluster, prefixes, policy), /BRIDGE_254_OBSERVER_/u)
})

test('production query reads migration and invalid-index catalogs only', () => {
  assert.match(BRIDGE_254_OBSERVE_SQL, /FROM public\.schema_migrations/u)
  assert.match(BRIDGE_254_OBSERVE_SQL, /NOT i\.indisvalid OR NOT i\.indisready/u)
  assert.doesNotMatch(BRIDGE_254_OBSERVE_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/iu)
  assert.match(BRIDGE_254_CLUSTER_SQL, /pg_control_system\(\)/u)
  assert.doesNotMatch(BRIDGE_254_CLUSTER_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/iu)
})
