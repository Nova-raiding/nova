import assert from 'node:assert/strict'
import test from 'node:test'
import { DEMO_254_REPLACE_SERVICES, DEMO_254_PRESERVE_SERVICES,
  reviewDemo254OldRuntimeCapsule } from '../infra/protected/demo-254-old-runtime-capsule.mjs'

const d = 'a'.repeat(64)
const identity = { release_id: 'release-f48c8454-dual-e2e', git_sha: 'b'.repeat(40),
  manifest_sha256: d, image_set_digest: `sha256:${d}` }
const database = { version: 254, history_sha256: d,
  volume_name: 'merchant-demo-85575f9c_merchant-postgres', backup_capture_sha256: d }
const imageFor = role => `sha256:${role === 'api' ? 'a'.repeat(64) : role === 'worker-sync' ? 'b'.repeat(64) : 'c'.repeat(64)}`
const item = role => ({ role, container_id: d, image_id: imageFor(role),
  image_ref: `127.0.0.1:5000/storenova/${role}@sha256:${d}`,
  compose_file: `/var/lib/merchant-release-security/deployments/release-${role}/candidate.compose.json`,
  compose_sha256: d, env_file: `/var/lib/merchant-release-security/deployments/release-${role}/candidate.env`,
  env_sha256: d, config_hash: d, rendered_config_hash: d, network_sha256: d, mounts_sha256: d })
const uniquely = (roles, offset) => roles.map((role, index) => ({ ...item(role), container_id: (index + offset).toString(16).padStart(64, '0') }))
const now = new Date('2026-09-28T06:00:00.000Z')
function fixture() {
  const capsule = { schema_version: 'demo-254-old-runtime-capsule/2',
    created_at: '2026-09-28T05:00:00.000Z', expires_at: '2026-09-29T05:00:00.000Z',
    project: 'merchant-demo-85575f9c', public_release: identity, database,
    replace: uniquely(DEMO_254_REPLACE_SERVICES, 1), preserve: uniquely(DEMO_254_PRESERVE_SERVICES, 8),
    external_consumers: [{ role: 'worker-scan', container_id: d, database_target_sha256: d,
      queue_target_sha256: d, disposition: 'proven_unrelated' }],
    runtime_archive: { kind: 'docker-save-runtime-images', sha256: d, bytes: 4096,
      image_ids: [imageFor('api'), imageFor('worker-sync'), imageFor('pilot-gateway')] },
    recovery: { strategy: 'forward_only', schema_downgrade: false, volumes_preserve: true,
      gateway_preserve: true, database_target_version: 254 } }
  return { capsule, observed: { public_release: identity, database, replace: capsule.replace,
    preserve: capsule.preserve, external_consumers: capsule.external_consumers,
    runtime_archive: capsule.runtime_archive },
    expected: { public_release: identity, database } }
}
const review = value => reviewDemo254OldRuntimeCapsule(value.capsule, value.observed, value.expected, now)

test('exact mixed runtime is structurally reviewable but never deployable', () => {
  const result = review(fixture())
  assert.deepEqual(result.errors, [])
  assert.equal(result.structure_consistent, true)
  assert.equal(result.deployable, false)
  assert.equal(result.signature_verified, false)
  assert.equal(result.recovery_exercised, false)
})

test('source drift, missing worker and mutable image fail closed', () => {
  let value = fixture()
  value.observed = { ...value.observed, replace: value.observed.replace.map((item, index) =>
    index === 2 ? { ...item, compose_sha256: 'f'.repeat(64) } : item) }
  assert.ok(review(value).errors.includes('CONTAINER_OR_SOURCE_DRIFT'))
  value = fixture(); value.capsule.replace.pop()
  assert.ok(review(value).errors.includes('REPLACE_SET_INVALID'))
  value = fixture(); value.capsule.replace[0].image_ref = 'storenova/merchant-api:latest'
  assert.ok(review(value).errors.includes('REPLACE_SET_INVALID'))
  value = fixture(); value.capsule.replace[0].rendered_config_hash = 'f'.repeat(64)
  assert.ok(review(value).errors.includes('REPLACE_SET_INVALID'))
  value = fixture(); value.capsule.preserve[0].container_id = value.capsule.replace[0].container_id
  assert.ok(review(value).errors.includes('MANAGED_CONTAINER_DUPLICATE'))
})

test('database advance, backup drift, and unsafe recovery fail closed', () => {
  let value = fixture(); value.capsule.database = { ...database, version: 255 }
  assert.ok(review(value).errors.includes('DATABASE_BINDING_INVALID'))
  value = fixture(); value.observed = { ...value.observed,
    database: { ...database, backup_capture_sha256: 'f'.repeat(64) } }
  assert.ok(review(value).errors.includes('DATABASE_DRIFT'))
  value = fixture(); value.capsule.recovery.schema_downgrade = true
  assert.ok(review(value).errors.includes('RECOVERY_POLICY_INVALID'))
  value = fixture(); value.capsule.recovery.volumes_preserve = false
  assert.ok(review(value).errors.includes('RECOVERY_POLICY_INVALID'))
})

test('missing shared scan consumer or unknown disposition fails closed', () => {
  let value = fixture(); value.capsule.external_consumers = []
  assert.ok(review(value).errors.includes('EXTERNAL_CONSUMER_UNRESOLVED'))
  value = fixture(); value.capsule.external_consumers[0].disposition = 'probably_unrelated'
  assert.ok(review(value).errors.includes('EXTERNAL_CONSUMER_UNRESOLVED'))
})

test('old runtime archive must bind exact API, worker and gateway image IDs and observed archive bytes', () => {
  let value = fixture(); value.capsule.runtime_archive.image_ids[0] = `sha256:${'d'.repeat(64)}`
  assert.ok(review(value).errors.includes('RUNTIME_ARCHIVE_DRIFT'))
  value = fixture(); value.observed = { ...value.observed,
    runtime_archive: { ...value.capsule.runtime_archive, sha256: 'f'.repeat(64) } }
  assert.ok(review(value).errors.includes('RUNTIME_ARCHIVE_DRIFT'))
  value = fixture(); value.capsule.runtime_archive.bytes = 0
  assert.ok(review(value).errors.includes('RUNTIME_ARCHIVE_INVALID'))
  value = fixture(); value.capsule.runtime_archive.image_ids[2] = value.capsule.runtime_archive.image_ids[1]
  assert.ok(review(value).errors.includes('RUNTIME_ARCHIVE_INVALID'))
  for (const archive of [null, undefined]) {
    value = fixture(); value.capsule.runtime_archive = archive
    assert.ok(review(value).errors.includes('RUNTIME_ARCHIVE_INVALID'))
  }
})

test('old runtime archive must cover every replaced service image, not only API and worker-sync', () => {
  for (const role of ['api-replica', 'worker-generation']) {
    const value = fixture()
    const target = value.capsule.replace.find(item => item.role === role)
    target.image_id = `sha256:${'d'.repeat(64)}`
    value.observed = { ...value.observed, replace: value.capsule.replace }
    assert.ok(review(value).errors.includes('RUNTIME_ARCHIVE_DRIFT'), `${role} image must be archived`)
  }
})

test('expiry and hand-added approval field fail closed', () => {
  let value = fixture(); value.capsule.expires_at = '2026-09-30T05:00:00.000Z'
  assert.ok(review(value).errors.includes('LIFETIME_INVALID'))
  value = fixture(); value.capsule.approved = true
  assert.deepEqual(review(value).errors, ['CAPSULE_SHAPE_INVALID'])
})
