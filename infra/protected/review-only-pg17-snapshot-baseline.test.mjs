import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { bindReviewOnlyBaseline, observeReviewOnlySnapshot, validateFrozenTablePlan } from './review-only-pg17-snapshot-baseline.mjs'
import { digestSortedPgRows } from './pg17-streamed-rowset.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const snapshot = '00000004-00000027-1'
const identity = { systemIdentifier: '1234567890123456789', databaseOid: 16384, databaseName: 'merchant', migrationVersion: 242 }
const sourcePolicy = { system_identifier_sha256: sha(identity.systemIdentifier), database_oid: identity.databaseOid, database_name: identity.databaseName }
const tablePlan = [{ schema: 'public', name: 'merchants', columns: [{ name: 'id', data_type: 'uuid', not_null: true }, { name: 'name', data_type: 'text', not_null: true }] }]
function database({ rows = ['["a","one"]', '["b","two"]'], source = {}, columns = tablePlan[0].columns, catalog = [{ schema: 'public', name: 'merchants', kind: 'r' }] } = {}) {
  const calls = []
  let ended = false
  const client = {
    async query(sql, params) {
      if (typeof sql === 'object') { queueMicrotask(() => { for (const row of rows) sql.emit('row', [row]); sql.emit('end') }); return }
      calls.push({ sql, params })
      if (sql.startsWith('SELECT (pg_control_system())')) return { rows: [{ system_identifier: identity.systemIdentifier, database_oid: identity.databaseOid, database_name: identity.databaseName, migration_version: 242, read_only: 'on', ...source }] }
      if (sql.startsWith('SELECT n.nspname')) return { rows: catalog }
      if (sql.startsWith('SELECT attname')) return { rows: columns }
      if (sql.startsWith('SELECT relrowsecurity')) return { rows: [{ enabled: true, forced: true }] }
      if (sql.startsWith('SELECT polname')) return { rows: [{ name: 'merchant_read', cmd: 'r', permissive: true, qual: 'true', with_check: null, roles: ['PUBLIC'] }] }
      if (sql.startsWith('SELECT json_build_array')) return { rows: rows.map(canonical_row => ({ canonical_row })) }
      return { rows: [] }
    },
    async end() { ended = true },
  }
  return { client, calls, ended: () => ended }
}
const input = (db, extra = {}) => ({ snapshot, identity, sourcePolicy, tablePlan, connect: async () => db.client, observedAt: () => '2026-09-27T00:00:00.000Z', ...extra })

test('joins the held snapshot before any read, freezes columns, and remains review-only', async () => {
  const db = database()
  const observation = await observeReviewOnlySnapshot(input(db))
  assert.deepEqual(db.calls.slice(0, 3).map(call => call.sql), ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', `SET TRANSACTION SNAPSHOT '${snapshot}'`, 'SET LOCAL row_security = off'])
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(db.ended(), true)
  assert.equal(observation.snapshot_id_sha256, sha(snapshot))
  assert.equal(observation.database_id_sha256, sha(identity.systemIdentifier))
  assert.equal(observation.tables[0].row_count, 2)
  assert.equal(observation.final_production_evidence, false)
  assert.equal(observation.source_provenance_verified, false)
  assert.equal(Object.hasOwn(observation, 'backup_sha256'), false)
  assert.match(db.calls.find(call => call.sql.startsWith('SELECT json_build_array')).sql, /FROM "public"\."merchants" AS t LIMIT \$1/u)
})

test('rejects changed source, frozen columns, and row overrun while closing the transaction', async () => {
  for (const db of [database({ source: { system_identifier: '999' } }), database({ columns: [{ name: 'id', data_type: 'text', not_null: true }] }), database({ rows: ['[]', '[]', '[]'] })]) {
    await assert.rejects(observeReviewOnlySnapshot(input(db, { maxRowsPerTable: 2 })), /source identity mismatch|column contract changed|row bound exceeded/u)
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
    assert.equal(db.ended(), true)
  }
})

test('refuses omitted or unsupported user relations in the same snapshot', async () => {
  for (const db of [database({ catalog: [{ schema: 'public', name: 'merchants', kind: 'r' }, { schema: 'public', name: 'orders', kind: 'r' }] }), database({ catalog: [{ schema: 'public', name: 'merchants', kind: 'm' }] })]) {
    await assert.rejects(observeReviewOnlySnapshot(input(db)), /complete user relation catalog|unsupported user relation kind/u)
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK')
    assert.equal(db.ended(), true)
  }
})

test('rejects invalid snapshot and unsafe or incomplete frozen plans before connecting', async () => {
  const db = database()
  await assert.rejects(observeReviewOnlySnapshot(input(db, { snapshot: "x'; DROP TABLE merchants;--" })), /snapshot identifier/u)
  await assert.rejects(observeReviewOnlySnapshot(input(db, { tablePlan: [{ ...tablePlan[0], name: 'merchants;drop' }] })), /identifier/u)
  await assert.rejects(observeReviewOnlySnapshot(input(db, { sourcePolicy: { ...sourcePolicy, database_oid: 1 } })), /policy mismatch/u)
  assert.deepEqual(db.calls, [])
  assert.throws(() => validateFrozenTablePlan([tablePlan[0], tablePlan[0]]), /duplicate frozen table/u)
})

test('binds only matching signed backup identity and retains review-only state', async () => {
  const observation = await observeReviewOnlySnapshot(input(database()))
  const attestation = { schema_version: '2', kind: 'postgres_backup', simulated: false, backup_sha256: 'a'.repeat(64), snapshot_id_sha256: sha(snapshot), source_database_id_sha256: sha(identity.systemIdentifier), migration_version: 242 }
  const bound = bindReviewOnlyBaseline(observation, attestation)
  assert.equal(bound.backup_sha256, attestation.backup_sha256)
  assert.equal(bound.final_production_evidence, false)
  assert.equal(bound.source_provenance_verified, false)
  assert.equal(bound.backup_document_signature_verified, false)
  assert.throws(() => bindReviewOnlyBaseline(observation, { ...attestation, snapshot_id_sha256: 'b'.repeat(64) }), /source mismatch/u)
  assert.throws(() => bindReviewOnlyBaseline({ ...observation, source_provenance_verified: true }, attestation), /review-only observation/u)
})

test('copies the frozen plan before awaiting the connector', async () => {
  const db = database()
  const mutable = structuredClone(tablePlan)
  const result = await observeReviewOnlySnapshot(input(db, { tablePlan: mutable, connect: async () => { mutable[0].columns[0].name = 'attacker_column'; return db.client } }))
  assert.equal(result.table_plan_sha256, sha(JSON.stringify(tablePlan)))
  assert.match(db.calls.find(call => call.sql.startsWith('SELECT json_build_array')).sql, /t\."id"/u)
})

test('uses the C-ordered streaming adapter for a held snapshot without a batch row query', async () => {
  const db = database({ rows: ['["a","one"]', '["a","one"]', '["b","two"]'] })
  const observation = await observeReviewOnlySnapshot(input(db, { streamRows: digestSortedPgRows, maxRowsPerTable: 1_000_000 }))
  assert.equal(observation.sampling_mode, 'streamed_pg_rows')
  assert.equal(observation.tables[0].row_count, 3)
  assert.equal(db.calls.some(call => call.sql.startsWith('SELECT json_build_array')), false)
  assert.equal(db.ended(), true)
})
