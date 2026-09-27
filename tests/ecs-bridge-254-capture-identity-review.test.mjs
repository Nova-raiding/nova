import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { reviewBridge254LiveCaptureIdentity } from '../infra/protected/ecs-bridge-254-capture-identity-review.mjs'

const h = char => char.repeat(64)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const sha = value => createHash('sha256').update(canonical(value)).digest('hex')
const roles = [
  ['api-replica', 'merchant-production-api-replica-1'],
  ['worker-sync', 'merchant-production-worker-sync-1'],
  ['worker-generation', 'merchant-production-worker-generation-1'],
  ['worker-publish', 'merchant-production-worker-publish-1'],
  ['worker-reconcile', 'merchant-production-worker-reconcile-1'],
  ['worker-automation', 'merchant-production-worker-automation-1'],
  ['worker-scan', 'merchant-production-worker-scan-1'],
  ['external-gateway', 'merchant-demo-85575f9c-pilot-gateway-1'],
]
function fixture() {
  const oldRuntime = { release_id: 'release-old', git_sha: 'a'.repeat(40), manifest_sha256: h('b'), image_set_digest: `sha256:${h('c')}` }
  const bridge = { release_id: 'release-bridge', git_sha: 'd'.repeat(40), manifest_sha256: h('e'), image_set_digest: `sha256:${h('f')}` }
  const inspected = roles.map(([role, name], index) => ({
    Name: `/${name}`, Id: index.toString(16).padStart(64, '0'), Image: `sha256:${(index + 8).toString(16).padStart(64, '0')}`,
    State: { Running: true }, Config: { Labels: {} },
    NetworkSettings: { Networks: { [`network-${index}`]: { NetworkID: h('9') } },
      Ports: role === 'external-gateway' ? { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }], '8443/tcp': [{ HostIp: '0.0.0.0', HostPort: '443' }] } : {} },
  }))
  const prefixes = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [String(index + 242), h('1')]))
  const capture = {
    schema_version: 'ecs-bridge-254-capture/1',
    database: { runtime: { version: 242, history_sha256: prefixes['242'] }, ops: { version: 242, history_sha256: prefixes['242'] } },
    containers: roles.map(([role], index) => ({ role, id: inspected[index].Id, image_id: inspected[index].Image,
      inspect_sha256: sha(inspected[index]), network_sha256: sha(inspected[index].NetworkSettings.Networks), running: true })),
    public_release: oldRuntime,
    bridge_artifacts: { ...bridge, services: ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'],
      compose_sha256: h('2'), env_sha256: h('3'), image_digests_sha256: h('4') },
    old_recovery: { preserve_volumes: true, compose_sha256: h('5'), env_sha256: h('6'), image_digests_sha256: h('7') },
  }
  const expected = { project: 'merchant-production', prefixes, oldRuntime, bridge }
  const publicRelease = { data: { release: { release_id: oldRuntime.release_id, release_git_sha: oldRuntime.git_sha,
    manifest_sha256: oldRuntime.manifest_sha256, image_set_digest: oldRuntime.image_set_digest } } }
  return { capture, expected, inspected, publicRelease }
}
function runner(input, calls) {
  return (command, args) => {
    calls.push([command, ...args])
    if (command === 'docker') return JSON.stringify(input.inspected)
    if (command === 'curl') return JSON.stringify(input.publicRelease)
    throw new Error('unexpected executable')
  }
}

test('matching live Docker and public identity remains review-only with database and recovery blockers', () => {
  const input = fixture(), calls = []
  const result = reviewBridge254LiveCaptureIdentity({ capture: input.capture, expected: input.expected, run: runner(input, calls) })
  assert.equal(result.status, 'review_only')
  assert.equal(result.docker_and_public_identity_consistent, true)
  assert.equal(result.production_authorized, false)
  assert.equal(result.deployable, false)
  assert.equal(result.database_roles_verified, false)
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['docker', 'inspect'], ['curl', '--fail']])
})

test('changed live container bytes, public identity, and gateway ports block the capture', () => {
  for (const mutate of [
    input => { input.inspected[0].Config.Labels.extra = 'drift' },
    input => { input.publicRelease.data.release.release_git_sha = '0'.repeat(40) },
    input => { input.inspected[7].NetworkSettings.Ports['8443/tcp'][0].HostPort = '8444' },
  ]) {
    const input = fixture(), calls = []
    mutate(input)
    const result = reviewBridge254LiveCaptureIdentity({ capture: input.capture, expected: input.expected, run: runner(input, calls) })
    assert.equal(result.status, 'blocked')
    assert.equal(result.docker_and_public_identity_consistent, false)
    assert.equal(result.production_authorized, false)
  }
})

test('missing Docker identities or malformed capture fail closed before any mutation', () => {
  const input = fixture(), calls = []
  input.inspected.pop()
  assert.throws(() => reviewBridge254LiveCaptureIdentity({ capture: input.capture, expected: input.expected, run: runner(input, calls) }), /all eight containers/u)
  const malformed = fixture(), neverCalled = []
  malformed.capture.containers.pop()
  assert.throws(() => reviewBridge254LiveCaptureIdentity({ capture: malformed.capture, expected: malformed.expected, run: runner(malformed, neverCalled) }), /OLD_RUNTIME_INCOMPLETE/u)
  assert.equal(neverCalled.length, 0)
  const conflicting = fixture(), noObservation = []
  conflicting.expected.old_runtime = { ...conflicting.expected.oldRuntime, release_id: 'release-other' }
  assert.throws(() => reviewBridge254LiveCaptureIdentity({ capture: conflicting.capture, expected: conflicting.expected, run: runner(conflicting, noObservation) }), /signed-state old identities differ/u)
  assert.equal(noObservation.length, 0)
})

test('matching malformed release values cannot pass as a frozen or live identity', () => {
  const frozen = fixture(), calls = []
  frozen.capture.public_release.git_sha = 'not-a-git-sha'
  frozen.expected.oldRuntime.git_sha = 'not-a-git-sha'
  assert.throws(() => reviewBridge254LiveCaptureIdentity({ capture: frozen.capture, expected: frozen.expected, run: runner(frozen, calls) }), /old release identities are invalid/u)
  assert.equal(calls.length, 0)

  const live = fixture()
  live.publicRelease.data.release.manifest_sha256 = 'invalid'
  assert.throws(() => reviewBridge254LiveCaptureIdentity({ capture: live.capture, expected: live.expected, run: runner(live, []) }), /public release identity fields are invalid/u)
})
