import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { reviewOnlyPreSignSnapshotCheck, reviewOnlyVerifyFrozenPlan, signFrozenPlanFromObservedCatalog } from './review-only-pg17-frozen-plan-preflight.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const releaseId = 'release-39fc097d-review'
const gitSha = 'a'.repeat(40)
const keyId = 'pg17-plan-review-key-1'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const trustedPublicKey = publicKey.export({ type: 'spki', format: 'pem' })
const systemIdentifier = '1234567890123456789'
const policy = { system_identifier_sha256: hash(systemIdentifier), database_oid: 16384, database_name: 'merchant' }
const sourcePolicyBytes = Buffer.from(`${JSON.stringify(policy)}\n`)
const tablePlan = [{ schema: 'public', name: 'merchants', columns: [{ name: 'id', data_type: 'uuid', not_null: true }] }]

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function signedBytes(changes = {}) {
  const unsigned = { schema_version: 'pg17-frozen-table-plan/1', kind: 'rowset_plan', release_id: releaseId, release_git_sha: gitSha, source_policy_sha256: hash(sourcePolicyBytes), source_database_id_sha256: policy.system_identifier_sha256, migration_version: 242, row_canonicalization: 'pg17-canonical-rows/1', rls_canonicalization: 'pg17-rls-policy/1', signed_at: '2026-09-27T00:00:00.000Z', expires_at: '2026-09-28T00:00:00.000Z', key_id: keyId, table_plan: structuredClone(tablePlan), ...changes }
  const payload = Buffer.concat([Buffer.from('merchant/pg17-frozen-table-plan/1\0'), Buffer.from(canonical(unsigned))])
  return Buffer.from(`${canonical({ ...unsigned, signature_base64: sign(null, payload, privateKey).toString('base64') })}\n`)
}
const args = planBytes => ({ planBytes, sourcePolicyBytes, trustedPublicKey, trustedKeyId: keyId, expectedReleaseId: releaseId, expectedGitSha: gitSha, expectedMigrationVersion: 242, now: new Date('2026-09-27T12:00:00.000Z') })

test('accepts a candidate/source-bound signed plan but never emits production evidence', () => {
  const planBytes = signedBytes()
  const result = reviewOnlyVerifyFrozenPlan(args(planBytes))
  assert.equal(result.plan_sha256, hash(planBytes))
  assert.equal(result.source_policy_sha256, hash(sourcePolicyBytes))
  assert.deepEqual(result.table_plan, tablePlan)
  assert.equal(result.final_production_evidence, false)
  assert.equal(result.source_provenance_verified, false)
})

test('signer round-trip accepts only a reviewed catalog and separate Ed25519 key', () => {
  const bytes = signFrozenPlanFromObservedCatalog({ tablePlan, sourcePolicyBytes, releaseId, gitSha, migrationVersion: 242, keyId, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKeyPem: trustedPublicKey, signedAt: '2026-09-27T00:00:00.000Z', expiresAt: '2026-09-28T00:00:00.000Z' })
  assert.deepEqual(reviewOnlyVerifyFrozenPlan(args(bytes)).table_plan, tablePlan)
  assert.throws(() => signFrozenPlanFromObservedCatalog({ tablePlan: [{ ...tablePlan[0], name: 'bad;table' }], sourcePolicyBytes, releaseId, gitSha, migrationVersion: 242, keyId, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKeyPem: trustedPublicKey, signedAt: '2026-09-27T00:00:00.000Z', expiresAt: '2026-09-28T00:00:00.000Z' }), /identifier/u)
})

test('rejects modified bytes, invalid signature, wrong source, candidate, and key', () => {
  const planBytes = signedBytes()
  const replaced = Buffer.from(planBytes.toString().replace('merchants', 'customers'))
  assert.throws(() => reviewOnlyVerifyFrozenPlan(args(replaced)), /signature invalid/u)
  assert.throws(() => reviewOnlyVerifyFrozenPlan(args(Buffer.from(` ${planBytes}`))), /bytes are not canonical/u)
  assert.throws(() => reviewOnlyVerifyFrozenPlan({ ...args(planBytes), sourcePolicyBytes: Buffer.from(`${JSON.stringify({ ...policy, database_oid: 99 })}\n`) }), /source policy mismatch/u)
  assert.throws(() => reviewOnlyVerifyFrozenPlan({ ...args(planBytes), expectedGitSha: 'c'.repeat(40) }), /candidate mismatch/u)
  assert.throws(() => reviewOnlyVerifyFrozenPlan({ ...args(planBytes), trustedKeyId: 'another-key' }), /key identity mismatch/u)
  assert.throws(() => reviewOnlyVerifyFrozenPlan({ ...args(planBytes), now: new Date('2026-09-28T00:00:00.000Z') }), /validity invalid/u)
})

test('rejects incomplete nested contracts, unordered tables, and noncanonical policy', () => {
  assert.throws(() => reviewOnlyVerifyFrozenPlan(args(signedBytes({ table_plan: [{ ...tablePlan[0], extra: 'unsigned metadata' }] }))), /nested fields invalid/u)
  const unordered = [{ schema: 'public', name: 'zeta', columns: tablePlan[0].columns }, tablePlan[0]]
  assert.throws(() => reviewOnlyVerifyFrozenPlan(args(signedBytes({ table_plan: unordered }))), /tables must be ordered/u)
  const planBytes = signedBytes()
  assert.throws(() => reviewOnlyVerifyFrozenPlan({ ...args(planBytes), sourcePolicyBytes: Buffer.from(JSON.stringify(policy)) }), /policy bytes are not canonical/u)
})

test('combines signed plan verification with the held snapshot and complete catalog', async () => {
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      if (sql.startsWith('SELECT (pg_control_system())')) return { rows: [{ system_identifier: systemIdentifier, database_oid: 16384, database_name: 'merchant', migration_version: 242, read_only: 'on' }] }
      if (sql.startsWith('SELECT n.nspname')) return { rows: [{ schema: 'public', name: 'merchants', kind: 'r' }] }
      if (sql.startsWith('SELECT attname')) return { rows: tablePlan[0].columns }
      if (sql.startsWith('SELECT relrowsecurity')) return { rows: [{ enabled: true, forced: true }] }
      if (sql.startsWith('SELECT polname')) return { rows: [] }
      if (sql.startsWith('SELECT json_build_array')) return { rows: [{ canonical_row: '["id"]' }] }
      return { rows: [] }
    },
    async end() { calls.push('END') },
  }
  const snapshot = '00000004-00000027-1'
  const identity = { systemIdentifier, databaseOid: 16384, databaseName: 'merchant', migrationVersion: 242 }
  const result = await reviewOnlyPreSignSnapshotCheck({ ...args(signedBytes()), snapshot, identity, connect: async () => client, observedAt: () => '2026-09-27T12:01:00.000Z' })
  assert.deepEqual(calls.slice(0, 2), ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', `SET TRANSACTION SNAPSHOT '${snapshot}'`])
  assert.equal(result.observation.tables[0].row_count, 1)
  assert.equal(result.final_production_evidence, false)
  assert.equal(result.source_provenance_verified, false)
  assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'END'])
  await assert.rejects(reviewOnlyPreSignSnapshotCheck({ ...args(signedBytes()), snapshot, identity: { ...identity, systemIdentifier: '9' }, connect: async () => { throw new Error('connection should not open') } }), /source differs/u)
})
