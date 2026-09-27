import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BRIDGE_254_MAINTENANCE_SERVICES, assertBridge254Drain, assertBridge254FrozenCapture, executeBridge254Maintenance } from '../infra/protected/ecs-bridge-254-maintenance-core.mjs'

const hex = digit => digit.repeat(64)
const identity = name => ({ release_id: name, git_sha: 'a'.repeat(40), manifest_sha256: hex('b'), image_set_digest: `sha256:${hex('c')}` })
const prefixes = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [String(index + 242), hex((index % 10).toString())]))
const expected = { project: 'merchant-production', prefixes, oldRuntime: identity('old'), bridge: identity('bridge') }
const capture = () => ({
  schema_version: 'ecs-bridge-254-capture/1', database: { runtime: { version: 242, history_sha256: prefixes['242'] }, ops: { version: 242, history_sha256: prefixes['242'] } },
  containers: [...BRIDGE_254_MAINTENANCE_SERVICES.filter(role => role !== 'api'), 'external-gateway'].map((role, index) => ({ role, id: (index + 1).toString(16).repeat(64), image_id: `sha256:${hex('a')}`, inspect_sha256: hex('b'), network_sha256: hex('c'), running: true })),
  public_release: identity('old'),
  bridge_artifacts: { ...identity('bridge'), services: [...BRIDGE_254_MAINTENANCE_SERVICES], compose_sha256: hex('a'), env_sha256: hex('b'), image_digests_sha256: hex('c') },
  old_recovery: { preserve_volumes: true, compose_sha256: hex('a'), env_sha256: hex('b'), image_digests_sha256: hex('c') },
})
const prefix = version => ({ version, history_sha256: prefixes[String(version)], ops_version: version, ops_history_sha256: prefixes[String(version)] })
const drain = () => ({ ingress_fenced: true, callbacks_fenced: true, fence_observed_from_gateway: true,
  in_flight_requests: 0, active_worker_cycles: 0, active_outbox_leases: 0, provider_started_unresolved: 0, observation_sha256: hex('e') })

test('capture requires exact eight old containers, external gateway and 242 identity', () => {
  assert.match(assertBridge254FrozenCapture(capture(), expected), /^[a-f0-9]{64}$/u)
  const missing = capture(); missing.containers.pop()
  assert.throws(() => assertBridge254FrozenCapture(missing, expected), /OLD_RUNTIME_INCOMPLETE/u)
  const wrong = capture(); wrong.containers.at(-1).id = wrong.containers[0].id
  assert.throws(() => assertBridge254FrozenCapture(wrong, expected), /OLD_RUNTIME_INCOMPLETE/u)
})

test('drain refuses a provider-started unknown request', () => {
  const observation = drain(); observation.provider_started_unresolved = 1
  assert.throws(() => assertBridge254Drain(observation), /TASKS_NOT_DRAINED/u)
})

function ports(failAt = null) {
  let version = 242, journal = null, fenced = false, bridge254Started = false
  const calls = []
  const runtime = {
    assertProtectedLock: async () => { calls.push('lock') },
    captureExactOldRuntime: async () => capture(),
    buildCapturedJournalBody: async ({ attemptId, captureSha }) => ({ attempt_id: attemptId, baseline_inventory_sha256: captureSha }),
    observePrefix: async () => prefix(version),
    fenceIngressAndCallbacks: async () => ({ ingress_fenced: true, callbacks_fenced: true }),
    observeDrain: async () => drain(),
    stopOldRuntimeGracefully: async () => ({ all_eight_stopped: true, gateway_fenced: true, no_active_processes: true }),
    backupAndRestore242: async () => ({ restored_prefix: prefix(242), archive_sha256: hex('f'), signed: true }),
    startBridgeAt242: async () => ({ all_eight_running: true, ingress_fenced: true }),
    verifyBridgeAt242: async () => ({ identity_verified: true, api_ready: true, six_workers_ready: true, observation_sha256: hex('b') }),
    stopBridgeForMigration: async () => {},
    observeStoppedTraffic: async () => ({ all_runtime_stopped: true, ingress_fenced: true, callbacks_fenced: true }),
    applySingleMigration: async target => { calls.push(`migrate-${target}`); if (target === failAt) throw new Error('synthetic migration failure'); version = target },
    keepIngressFencedForForwardRecovery: async () => { fenced = true },
    startBridgeAt254: async () => { bridge254Started = true; return { all_eight_running: true, ingress_fenced: true } },
    verifyBridgeAt254: async () => ({ identity_verified: true, api_ready: true, six_workers_ready: true, public_release_verified: true, observation_sha256: hex('d') }),
  }
  const control = {
    capture: async ({ journalBody }) => (journal = { phase: 'captured', baseline_inventory_sha256: journalBody.baseline_inventory_sha256, allowed_prefix_sha256: prefixes, database_prefix: prefix(242) }),
    advance: async ({ fromPhase, toPhase, observedPrefix }) => {
      assert.equal(journal.phase, fromPhase)
      return (journal = { ...journal, phase: toPhase, database_prefix: observedPrefix })
    },
    recordPrefix: async ({ expectedVersion, observedPrefix }) => {
      assert.equal(journal.database_prefix.version, expectedVersion)
      return (journal = { ...journal, database_prefix: observedPrefix })
    },
  }
  return { runtime, control, calls, get fenced() { return fenced }, get bridge254Started() { return bridge254Started } }
}

test('core sequences every forward prefix and keeps ingress fenced after 254', async () => {
  const p = ports()
  const result = await executeBridge254Maintenance({ ...p, attemptId: 'bridgeattempt0001', expected, deploymentNonce: 'n'.repeat(22) })
  assert.deepEqual(p.calls.filter(value => value.startsWith('migrate-')), Array.from({ length: 12 }, (_, index) => `migrate-${index + 243}`))
  assert.deepEqual(result, { status: 'verified_fenced', migration_version: 254, ingress_fenced: true, release_authorized: false,
    journal_phase: 'migration_254_verified', runtime_observation_sha256: hex('d') })
})

test('an intermediate failure never starts 254 and requests forward-only fence', async () => {
  const p = ports(249)
  await assert.rejects(executeBridge254Maintenance({ ...p, attemptId: 'bridgeattempt0002', expected, deploymentNonce: 'n'.repeat(22) }), /synthetic migration failure/u)
  assert.equal(p.fenced, true)
  assert.equal(p.bridge254Started, false)
})
