import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BRIDGE_254_OBSERVE_SQL, bridge254DatabaseEnvironment,
  openProductionBridge254RuntimeObserver, verifyBridge254ObservedHistories } from '../infra/protected/ecs-bridge-254-runtime-observer.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const history = Array.from({ length: 254 }, (_, i) => [i + 1, `migration_${i + 1}`, sha(`sql-${i + 1}`)])
const prefixes = Object.fromEntries(Array.from({ length: 13 }, (_, i) => {
  const version = 242 + i
  return [String(version), sha(history.slice(0, version).map(([n, name, checksum]) => `${n}\t${name}\t${checksum}\n`).join(''))]
}))
const observe = version => ({ history: history.slice(0, version), invalid_indexes: [] })

test('returns exact matching runtime and ops history for each approved prefix', () => {
  for (let version = 242; version <= 254; version += 1) {
    assert.deepEqual(verifyBridge254ObservedHistories(observe(version), observe(version), prefixes), {
      version, history_sha256: prefixes[version], ops_version: version, ops_history_sha256: prefixes[version],
    })
  }
})

test('fails closed on gaps, duplicate/mismatched checksums, drift, invalid indexes and unknown prefix', () => {
  for (const [runtime, ops, plan] of [
    [observe(241), observe(241), prefixes],
    [{ history: [...history, [255, 'migration_255', sha('sql-255')]], invalid_indexes: [] }, observe(254), prefixes],
    [{ history: [...history.slice(0, 242), history[241]], invalid_indexes: [] }, observe(243), prefixes],
    [{ history: history.slice(0, 242).map((row, i) => i === 30 ? [99, row[1], row[2]] : row), invalid_indexes: [] }, observe(242), prefixes],
    [{ history: history.slice(0, 242).map((row, i) => i === 30 ? [row[0], row[1], 'f'.repeat(64)] : row), invalid_indexes: [] }, observe(242), prefixes],
    [observe(242), observe(243), prefixes],
    [{ history: history.slice(0, 242), invalid_indexes: ['unsafe_idx'] }, observe(242), prefixes],
    [observe(242), observe(242), { ...prefixes, 242: 'f'.repeat(64) }],
    [observe(242), observe(242), { 242: prefixes[242] }],
  ]) assert.throws(() => verifyBridge254ObservedHistories(runtime, ops, plan), /BRIDGE_254_OBSERVER_/u)
})

test('requires explicit TLS URLs for distinct unprivileged roles and read-only PG options', () => {
  const app = bridge254DatabaseEnvironment('postgres://merchant_app:private@db.example:5432/merchant?sslmode=verify-full', 'merchant_app')
  assert.equal(app.PGUSER, 'merchant_app')
  assert.equal(app.PGSSLMODE, 'verify-full')
  assert.match(app.PGOPTIONS, /default_transaction_read_only=on/u)
  assert.doesNotMatch(JSON.stringify({ ...app, PGPASSWORD: undefined }), /private/u)
  for (const url of [
    'postgres://merchant_ops:private@db.example/merchant?sslmode=require',
    'postgres://merchant_app:private@db.example/merchant',
    'postgres://merchant_app:private@db.example/merchant?sslmode=disable',
    'postgres://merchant_app:private@db.example/merchant?sslmode=require&options=-c',
    'postgres://merchant_app:private@db.example/other?sslmode=require',
  ]) assert.throws(() => bridge254DatabaseEnvironment(url, 'merchant_app'), /BRIDGE_254_OBSERVER_/u)
  assert.throws(() => openProductionBridge254RuntimeObserver({ frozenPrefixes: prefixes }), /EXPLICIT_DATABASE_URLS_REQUIRED/u)
})

test('production query reads migration and invalid-index catalogs only', () => {
  assert.match(BRIDGE_254_OBSERVE_SQL, /FROM schema_migrations/u)
  assert.match(BRIDGE_254_OBSERVE_SQL, /NOT i\.indisvalid OR NOT i\.indisready/u)
  assert.doesNotMatch(BRIDGE_254_OBSERVE_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/iu)
})
