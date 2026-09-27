import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { signFrozenPlanFromObservedCatalog } from './attest-pg17-frozen-plan.mjs'
import { reviewOnlyVerifyFrozenPlan } from './review-only-pg17-frozen-plan-preflight.mjs'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const sourcePolicyBytes = Buffer.from(`${JSON.stringify({ system_identifier_sha256: createHash('sha256').update('1234567890123456789').digest('hex'), database_oid: 16384, database_name: 'merchant' })}\n`)
const tablePlan = [{ schema: 'public', name: 'merchants', columns: [{ name: 'id', data_type: 'uuid', not_null: true }] }]
const releaseId = 'release-39fc097d-review'
const gitSha = '1'.repeat(40)
const keyId = 'production-test'
const signedAt = '2026-09-27T00:00:00.000Z'
const expiresAt = '2026-09-28T00:00:00.000Z'

test('protected signer emits a domain-separated, independently verified full plan', () => {
  const planBytes = signFrozenPlanFromObservedCatalog({ tablePlan, sourcePolicyBytes, releaseId, gitSha, migrationVersion: 242, keyId, privateKeyPem, publicKeyPem, signedAt, expiresAt })
  const verified = reviewOnlyVerifyFrozenPlan({ planBytes, sourcePolicyBytes, trustedPublicKey: publicKeyPem, trustedKeyId: keyId, expectedReleaseId: releaseId, expectedGitSha: gitSha, expectedMigrationVersion: 242, now: new Date(signedAt) })
  assert.deepEqual(verified.table_plan, tablePlan)
  assert.equal(verified.final_production_evidence, false)
  const changed = Buffer.from(planBytes.toString().replace('merchants', 'customers'))
  assert.throws(() => reviewOnlyVerifyFrozenPlan({ planBytes: changed, sourcePolicyBytes, trustedPublicKey: publicKeyPem, trustedKeyId: keyId, expectedReleaseId: releaseId, expectedGitSha: gitSha, expectedMigrationVersion: 242, now: new Date(signedAt) }), /signature|canonical/u)
})

test('protected signer rejects an invalid plan before returning bytes', () => {
  assert.throws(() => signFrozenPlanFromObservedCatalog({ tablePlan: [], sourcePolicyBytes, releaseId, gitSha, migrationVersion: 242, keyId, privateKeyPem, publicKeyPem, signedAt, expiresAt }), /frozen table plan/u)
})
