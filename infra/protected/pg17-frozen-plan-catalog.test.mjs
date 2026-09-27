import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { collectFrozenPlanCatalog } from './pg17-frozen-plan-catalog.mjs'

const system = '1234567890123456789'
const policy = { system_identifier_sha256: createHash('sha256').update(system).digest('hex'), database_oid: 16384, database_name: 'merchant' }
function clientFor({ kind = 'r', version = 242, name = 'merchants' } = {}) {
  const calls = []
  const client = { async query(sql) {
    calls.push(sql)
    if (sql.startsWith('SELECT (pg_control_system())')) return { rows: [{ system_identifier: system, database_oid: 16384, database_name: 'merchant', migration_version: version, read_only: 'on' }] }
    if (sql.startsWith('SELECT n.nspname')) return { rows: [{ schema: 'public', name, kind, column_name: 'id', data_type: 'uuid', not_null: true }, { schema: 'public', name, kind, column_name: 'name', data_type: 'text', not_null: false }] }
    return { rows: [] }
  } }
  return { client, calls }
}

test('collects exact physical column order in one read-only catalog snapshot', async () => {
  const { client, calls } = clientFor()
  const result = await collectFrozenPlanCatalog(client, policy, 242)
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.match(calls[1], /^SELECT \(pg_control_system\(\)\)/u)
  assert.equal(calls.at(-1), 'ROLLBACK')
  assert.deepEqual(result.table_plan, [{ schema: 'public', name: 'merchants', columns: [{ name: 'id', data_type: 'uuid', not_null: true }, { name: 'name', data_type: 'text', not_null: false }] }])
})

test('rejects wrong source, migration or unsupported relation and rolls back', async () => {
  for (const fixture of [clientFor({ version: 243 }), clientFor({ kind: 'm' })]) {
    await assert.rejects(collectFrozenPlanCatalog(fixture.client, policy, 242), /source differs|unsupported user relation/u)
    assert.equal(fixture.calls.at(-1), 'ROLLBACK')
  }
})
