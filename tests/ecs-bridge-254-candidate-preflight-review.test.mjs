import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { reviewBridge254CandidatePreflight } from '../infra/scripts/review-ecs-bridge-254-candidate-preflight.mjs'

const SHA = 'a'.repeat(64)
const identity = { release_id: 'release-bridge-254', git_sha: 'b'.repeat(40),
  manifest_sha256: 'c'.repeat(64), image_set_digest: `sha256:${'d'.repeat(64)}` }
const apiImage = `merchant-api@sha256:${'e'.repeat(64)}`
const workerImage = `merchant-worker@sha256:${'f'.repeat(64)}`
const runtime = ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']
const support = ['ui', 'ops-ui', 'payment-gateway', 'pilot-gateway', 'clamav']
const changed = ['apps/api/src/server.ts', 'packages/persistence/src/commercial-catalog-repository.ts', 'packages/persistence/src/migration.ts']
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`

function fixture() {
  const environment = { BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_254', RUN_MIGRATIONS_ON_STARTUP: 'false',
    RELEASE_ID: identity.release_id, RELEASE_GIT_SHA: identity.git_sha,
    RELEASE_MANIFEST_SHA256: identity.manifest_sha256, RELEASE_IMAGE_SET_DIGEST: identity.image_set_digest }
  const rendered_compose = { services: Object.fromEntries([
    ...runtime.map(name => [name, { image: name.startsWith('api') ? apiImage : workerImage, environment: { ...environment } }]),
    ...support.map(name => [name, { image: `${name}@sha256:${SHA}`, environment: {} }]),
  ]) }
  const overlay_manifest = { schema_version: 'ecs-bridge-254-compatibility-overlay/1', status: 'review_only',
    deployable: false, runtime_verified: false, source_review_tree_sha256: `sha256:${'1'.repeat(64)}`,
    bridge_base_commit: '2'.repeat(40), migration_commit: '3'.repeat(40), changed_paths: [...changed],
    changed_digests: Object.fromEntries(changed.map(path => [path, `sha256:${'4'.repeat(64)}`])),
    overlay_tree_sha256: `sha256:${'5'.repeat(64)}`, missing_proof: ['real host and source evidence'] }
  const expected = { bridge: identity, bridge_base_commit: overlay_manifest.bridge_base_commit,
    migration_commit: overlay_manifest.migration_commit, migration_tail: 254,
    source_review_tree_sha256: overlay_manifest.source_review_tree_sha256,
    overlay_tree_sha256: overlay_manifest.overlay_tree_sha256,
    rendered_compose_sha256: digest(rendered_compose), api_image: apiImage, worker_image: workerImage }
  return { overlay_manifest, rendered_compose, expected }
}

test('complete static candidate remains blocked and never claims host evidence', () => {
  const result = reviewBridge254CandidatePreflight(fixture())
  assert.equal(result.static_cross_checks_passed, true)
  assert.equal(result.status, 'review_only')
  assert.equal(result.deployable, false)
  assert.equal(result.production_authorized, false)
  assert.equal(result.runtime_verified, false)
  assert(result.blockers.includes('PRODUCTION_NONCE_CONSUMER_AND_CONTROLLER_INSTALL_UNVERIFIED'))
  assert(result.blockers.includes('MAINTENANCE_FENCE_DRAIN_AND_BACKUP_UNVERIFIED'))
})

test('rejects manifest, source, image, and rendered Compose identity drift', () => {
  const cases = [
    input => { input.overlay_manifest.deployable = true },
    input => { input.overlay_manifest.runtime_verified = true },
    input => { input.overlay_manifest.overlay_tree_sha256 = `sha256:${'9'.repeat(64)}` },
    input => { input.overlay_manifest.changed_paths.pop() },
    input => { input.overlay_manifest.changed_digests[changed[0]] = `sha256:${'g'.repeat(64)}` },
    input => { input.rendered_compose.services['api-replica'].environment.RELEASE_MANIFEST_SHA256 = '0'.repeat(64) },
    input => { input.rendered_compose.services['worker-scan'].image = `merchant-worker@sha256:${'0'.repeat(64)}` },
    input => { input.rendered_compose.services.api.environment.BRIDGE_SCHEMA_COMPATIBILITY_MODE = 'prefix_242_or_244' },
    input => { input.rendered_compose.services.migrate = { image: apiImage, environment: {} } },
    input => { input.expected.migration_tail = 244 },
    input => { input.expected.rendered_compose_sha256 = `sha256:${'0'.repeat(64)}` },
  ]
  for (const [index, mutate] of cases.entries()) {
    const input = fixture()
    mutate(input)
    assert.throws(() => reviewBridge254CandidatePreflight(input), `mutation ${index} must fail closed`)
  }
})

test('CLI accepts only stdin review JSON and never emits a deployment GO', () => {
  const script = resolve('infra/scripts/review-ecs-bridge-254-candidate-preflight.mjs')
  const accepted = spawnSync(process.execPath, [script], { input: JSON.stringify(fixture()), encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.deepEqual(JSON.parse(accepted.stdout).production_authorized, false)
  const invalid = fixture()
  invalid.overlay_manifest.deployable = true
  const rejected = spawnSync(process.execPath, [script], { input: JSON.stringify(invalid), encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  assert.equal(rejected.stdout, '')
  assert.match(rejected.stderr, /review rejected/)
  assert.equal(spawnSync(process.execPath, [script, '--approve'], { input: JSON.stringify(fixture()), encoding: 'utf8' }).status, 1)
})
