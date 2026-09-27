// Deliberately untrusted local rehearsal: real PG17 and eight Docker Compose
// services, synthetic journal/capture. A successful run proves the controller
// refuses release when scanner/public identity cannot be verified locally.
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { assertBridge254FrozenCapture, BRIDGE_254_MAINTENANCE_SERVICES, resumeBridge254ForwardMaintenance } from '../infra/protected/ecs-bridge-254-maintenance-core.mjs'
import { createIsolatedBridge254IO } from './bridge-254-maintenance-isolated-io.mjs'

const [apiReference, workerReference, overlayTreeSha256, output] = process.argv.slice(2)
if (process.argv.length !== 6 || !apiReference || !workerReference || !/^sha256:[a-f0-9]{64}$/u.test(overlayTreeSha256 ?? '')
  || !isAbsolute(output ?? '') || resolve(output) !== output || existsSync(output)) throw new Error('usage: node --import tsx tests/bridge-254-maintenance-resume-smoke.mjs <API image> <worker image> <overlay tree SHA> <new absolute output.json>')
const sha = value => createHash('sha256').update(value).digest('hex')
const identity = release_id => ({ release_id, git_sha: 'a'.repeat(40), manifest_sha256: sha(release_id), image_set_digest: `sha256:${sha(`image:${release_id}`)}` })
const oldRuntime = identity('isolated-old')
const bridge = identity('isolated-bridge')
const attemptId = 'isolated_bridge_254_resume_01'
const deploymentNonce = 'isolated_bridge_254_nonce_00001'
let isolated
try {
  isolated = await createIsolatedBridge254IO({ apiReference, workerReference, overlayTreeSha256, initialPrefix: 243 })
  const expected = { project: 'merchant-production', prefixes: isolated.prefixes, oldRuntime, old_runtime: oldRuntime, bridge }
  const capture = {
    schema_version: 'ecs-bridge-254-capture/1',
    containers: [...BRIDGE_254_MAINTENANCE_SERVICES.filter(name => name !== 'api'), 'external-gateway'].map((role, index) => ({
      role, id: sha(`synthetic-old-${index}`), image_id: `sha256:${sha(`synthetic-image-${index}`)}`,
      inspect_sha256: sha(`synthetic-inspect-${index}`), network_sha256: sha(`synthetic-network-${index}`), running: true,
    })),
    database: { runtime: { version: 242, history_sha256: isolated.prefixes['242'] }, ops: { version: 242, history_sha256: isolated.prefixes['242'] } },
    public_release: oldRuntime,
    bridge_artifacts: { ...bridge, services: [...BRIDGE_254_MAINTENANCE_SERVICES], compose_sha256: sha('synthetic-compose'),
      env_sha256: sha('synthetic-env'), image_digests_sha256: sha('synthetic-image-set') },
    old_recovery: { preserve_volumes: true, compose_sha256: sha('synthetic-old-compose'), env_sha256: sha('synthetic-old-env'),
      image_digests_sha256: sha('synthetic-old-image-set') },
  }
  let journal = { phase: 'migration_started', baseline_inventory_sha256: assertBridge254FrozenCapture(capture, expected),
    allowed_prefix_sha256: isolated.prefixes, database_prefix: { version: 242, history_sha256: isolated.prefixes['242'] } }
  const control = {
    read: async () => ({ journal, capture }),
    advance: async ({ fromPhase, toPhase, observedPrefix }) => {
      if (journal.phase !== fromPhase) throw new Error('synthetic journal phase CAS mismatch')
      journal = { ...journal, phase: toPhase, database_prefix: { version: observedPrefix.version, history_sha256: observedPrefix.history_sha256 } }
      return { journal }
    },
    recordPrefix: async ({ expectedVersion, observedPrefix }) => {
      if (journal.database_prefix.version !== expectedVersion) throw new Error('synthetic journal prefix CAS mismatch')
      journal = { ...journal, database_prefix: { version: observedPrefix.version, history_sha256: observedPrefix.history_sha256 } }
      return { journal }
    },
  }
  let refusal = ''
  try { await resumeBridge254ForwardMaintenance({ control, runtime: isolated.port, attemptId, expected, deploymentNonce }) }
  catch (error) { refusal = error.message }
  const prefix = await isolated.port.observePrefix()
  const runtime = await isolated.port.verifyBridgeAt254()
  if (refusal !== 'BRIDGE_254_RESUME_BRIDGE_254_VERIFY_FAILED' || prefix.version !== 254 || prefix.history_sha256 !== isolated.prefixes['254']
    || !runtime.api_ready || runtime.six_workers_ready || runtime.public_release_verified) throw new Error(`isolated resume did not reach the expected fenced refusal: ${refusal}`)
  writeFileSync(output, `${JSON.stringify({ schema_version: 'bridge-254-maintenance-resume-isolated/1', status: 'review_only',
    deployable: false, production_evidence: false, signed_state_verified: false, old_capture_real: false,
    network: 'internal_no_published_ports', resumed_from_signed_version: 242, initial_live_version: 243,
    final_prefix: prefix, journal_phase: journal.phase, api_ready: runtime.api_ready, worker_observations: runtime.workers,
    public_release_verified: runtime.public_release_verified, refusal }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  process.stdout.write(`PASS isolated forward resume to 254 remains fenced at incomplete scanner/public identity; output=${output}\n`)
} finally {
  await isolated?.dispose()
}
