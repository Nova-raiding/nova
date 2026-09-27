// Review-only verifier for a separately approved PG17 rowset plan.
// It does not sign a plan, read protected host paths, or enable backup CLI callbacks.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { observeReviewOnlySnapshot, validateFrozenTablePlan } from './review-only-pg17-snapshot-baseline.mjs'

const HEX = /^[a-f0-9]{64}$/u
const RELEASE = /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const GIT = /^[a-f0-9]{40}$/u
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const FIELDS = ['expires_at', 'key_id', 'kind', 'migration_version', 'release_git_sha', 'release_id', 'rls_canonicalization', 'row_canonicalization', 'schema_version', 'signed_at', 'source_database_id_sha256', 'source_policy_sha256', 'table_plan', 'signature_base64'].sort()
const POLICY_FIELDS = ['database_name', 'database_oid', 'system_identifier_sha256']
const check = (condition, message) => { if (!condition) throw new Error(message) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function canonical(value, omitTopSignature = false) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'unsupported signed plan value')
  return `{${Object.keys(value).filter(key => !omitTopSignature || key !== 'signature_base64').sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function parseExact(bytes, max, label) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= max, `${label} bytes invalid`)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${label} JSON invalid`) }
  check(value && Object.getPrototypeOf(value) === Object.prototype, `${label} object invalid`)
  return value
}

export function reviewOnlyVerifyFrozenPlan({ planBytes, sourcePolicyBytes, trustedPublicKey, trustedKeyId, expectedReleaseId, expectedGitSha, expectedMigrationVersion, now = new Date() }) {
  const plan = parseExact(planBytes, 2 * 1024 * 1024, 'frozen plan')
  const policy = parseExact(sourcePolicyBytes, 4096, 'source policy')
  check(Object.keys(policy).sort().join(',') === POLICY_FIELDS.join(',') && HEX.test(policy.system_identifier_sha256 ?? '') && Number.isInteger(policy.database_oid) && policy.database_oid > 0 && typeof policy.database_name === 'string' && policy.database_name.length > 0, 'protected source policy invalid')
  check(sourcePolicyBytes.equals(Buffer.from(`${JSON.stringify({ system_identifier_sha256: policy.system_identifier_sha256, database_oid: policy.database_oid, database_name: policy.database_name })}\n`, 'utf8')), 'protected source policy bytes are not canonical')
  check(Object.keys(plan).sort().join(',') === FIELDS.join(','), 'frozen plan fields invalid')
  check(plan.schema_version === 'pg17-frozen-table-plan/1' && plan.kind === 'rowset_plan' && plan.row_canonicalization === 'pg17-canonical-rows/1' && plan.rls_canonicalization === 'pg17-rls-policy/1', 'frozen plan contract invalid')
  check(RELEASE.test(expectedReleaseId ?? '') && GIT.test(expectedGitSha ?? '') && Number.isSafeInteger(expectedMigrationVersion) && expectedMigrationVersion > 0, 'expected candidate identity invalid')
  check(plan.release_id === expectedReleaseId && plan.release_git_sha === expectedGitSha && plan.migration_version === expectedMigrationVersion, 'frozen plan candidate mismatch')
  check(plan.source_policy_sha256 === sha(sourcePolicyBytes) && plan.source_database_id_sha256 === policy.system_identifier_sha256, 'frozen plan source policy mismatch')
  check(KEY_ID.test(trustedKeyId ?? '') && plan.key_id === trustedKeyId, 'frozen plan key identity mismatch')
  check(UTC.test(plan.signed_at ?? '') && UTC.test(plan.expires_at ?? '') && Number.isFinite(Date.parse(plan.signed_at)) && Number.isFinite(Date.parse(plan.expires_at)) && Number.isFinite(now.getTime()) && Date.parse(plan.signed_at) <= now.getTime() && now.getTime() < Date.parse(plan.expires_at) && Date.parse(plan.expires_at) <= Date.parse(plan.signed_at) + 24 * 60 * 60_000, 'frozen plan validity invalid')
  validateFrozenTablePlan(plan.table_plan)
  check(plan.table_plan.every(table => Object.keys(table).sort().join(',') === 'columns,name,schema' && table.columns.every(column => Object.keys(column).sort().join(',') === 'data_type,name,not_null')), 'frozen plan nested fields invalid')
  const names = plan.table_plan.map(table => `${table.schema}.${table.name}`)
  check(names.join(',') === [...names].sort().join(','), 'frozen plan tables must be ordered')
  check(/^[A-Za-z0-9+/]{86}==$/u.test(plan.signature_base64 ?? ''), 'frozen plan signature malformed')
  check(planBytes.equals(Buffer.from(`${canonical(plan)}\n`, 'utf8')), 'frozen plan bytes are not canonical')
  const key = createPublicKey(trustedPublicKey)
  check(key.asymmetricKeyType === 'ed25519', 'frozen plan trust key must be Ed25519')
  const payload = Buffer.concat([Buffer.from('merchant/pg17-frozen-table-plan/1\0'), Buffer.from(canonical(plan, true))])
  check(verify(null, payload, key, Buffer.from(plan.signature_base64, 'base64')), 'frozen plan signature invalid')
  // The caller must independently prove root-owned file provenance, signer
  // authority and the live database catalog. This is still not release proof.
  return Object.freeze({ schema_version: 'pg17-review-only-frozen-plan-preflight/1', final_production_evidence: false, source_provenance_verified: false, plan_sha256: sha(planBytes), source_policy_sha256: sha(sourcePolicyBytes), release_id: plan.release_id, release_git_sha: plan.release_git_sha, migration_version: plan.migration_version, source_database_id_sha256: plan.source_database_id_sha256, table_plan: plan.table_plan.map(table => ({ schema: table.schema, name: table.name, columns: table.columns.map(column => ({ name: column.name, data_type: column.data_type, not_null: column.not_null })) })) })
}

export async function reviewOnlyPreSignSnapshotCheck({ snapshot, identity, connect, observedAt, maxRowsPerTable, ...planInputs }) {
  const plan = reviewOnlyVerifyFrozenPlan(planInputs)
  check(identity?.migrationVersion === plan.migration_version && sha(identity.systemIdentifier ?? '') === plan.source_database_id_sha256, 'held snapshot source differs from signed plan')
  const sourcePolicy = JSON.parse(planInputs.sourcePolicyBytes.toString('utf8'))
  const observation = await observeReviewOnlySnapshot({ snapshot, identity, sourcePolicy, tablePlan: plan.table_plan, connect, observedAt, maxRowsPerTable })
  check(observation.table_plan_sha256 === sha(JSON.stringify(plan.table_plan)), 'sampled table plan changed')
  return Object.freeze({ schema_version: 'pg17-review-only-pre-sign-snapshot-check/1', final_production_evidence: false, source_provenance_verified: false, plan_sha256: plan.plan_sha256, source_policy_sha256: plan.source_policy_sha256, snapshot_id_sha256: observation.snapshot_id_sha256, observation })
}
