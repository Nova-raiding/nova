import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { reviewBridge255Phase, validateBridge255Plan } from '../infra/protected/ecs-bridge-255-review.mjs'

const h = (char: string) => char.repeat(64)
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const services = ['api', 'api-replica', 'ui', 'ops-ui', 'payment-gateway', 'worker-sync',
  'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation',
  'postgres', 'redis', 'pilot-gateway']
const runtime = ['api', 'api-replica', 'worker-sync', 'worker-generation', 'worker-publish',
  'worker-reconcile', 'worker-automation']

function fixture(phase = 'captured_254') {
  const key = generateKeyPairSync('ed25519')
  const identity = (char: string) => ({ release_id: `release-${char}`, git_sha: char.repeat(40),
    manifest_sha256: h(char), image_set_digest: `sha256:${h(char)}` })
  const artifacts = (char: string) => ({ identity: identity(char), compose_sha256: h(char),
    env_sha256: h(char), image_digests_sha256: h(char) })
  const plan = {
    schema_version: 'ecs-bridge-255-plan/1', attempt_id: 'attempt_abcdefghijklmnop',
    project: 'merchant-demo-85575f9c', lock_path: '/var/lib/merchant-release-security/production-deploy.lock',
    nonce_sha256: h('a'), old_demo: artifacts('b'), bridge_254_255: artifacts('c'),
    candidate_255: artifacts('d'), recovery_255: artifacts('e'),
    database: { strategy: 'forward_only', schema_downgrade: false, preserve_volumes: true,
      prefix_254_sha256: h('1'), prefix_255_sha256: h('2') },
    pg17_image_ref: `sha256:${h('f')}`,
  }
  const prefix = (version: number) => ({ version, history_sha256: version === 254 ? h('1') : h('2'),
    ops_version: version, ops_history_sha256: version === 254 ? h('1') : h('2') })
  const captureBody = {
    project: plan.project, public_release: plan.old_demo.identity, database: prefix(254),
    containers: services.map((service, index) => ({ service,
      name: `${plan.project}-${service}-1`, project: plan.project, compose_service: service,
      id: index.toString(16).padStart(64, '0'), image_id: `sha256:${(index + 16).toString(16).padStart(64, '0')}`,
      inspect_sha256: h('3'), network_sha256: h('4'), running: true })),
    gateway_ports: { http: 80, https: 443 },
  }
  const capture = { ...captureBody, capture_sha256: digest(captureBody) }
  const migrated = ['verified_255', 'candidate_cutover', 'accepted_255'].includes(phase)
  const journalBody = { schema_version: 'ecs-bridge-255-journal/1', attempt_id: plan.attempt_id,
    plan_sha256: validateBridge255Plan(plan), phase,
    previous_journal_sha256: phase === 'captured_254' ? null : h('5'),
    nonce_sha256: plan.nonce_sha256, created_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString() }
  const journal = { ...journalBody,
    signature_base64: sign(null, Buffer.from(canonical(journalBody)), key.privateKey).toString('base64') }
  const observation = {
    phase, database: prefix(migrated ? 255 : 254), ingress_fenced: phase === 'captured_254' || phase === 'accepted_255' ? false : true,
    callbacks_fenced: phase === 'captured_254' || phase === 'accepted_255' ? false : true,
    in_flight_requests: 0, active_worker_cycles: 0, active_outbox_leases: 0,
    provider_started_unresolved: 0,
    stopped_services: phase === 'captured_254' || phase === 'accepted_255' ? [] : [...runtime],
    backup: phase === 'captured_254' ? null : { signed: true, pg17_image_ref: plan.pg17_image_ref,
      archive_sha256: h('6'), restored_prefix_version: 254, restored_prefix_sha256: h('1') },
    runtime: migrated ? { identity: phase === 'verified_255' ? plan.recovery_255.identity : plan.candidate_255.identity,
      api_ready: true, api_replica_ready: true, workers_ready: runtime.filter(name => name.startsWith('worker-')).length,
      business_canary_passed: true } : null,
    gateway: phase === 'captured_254' ? null : {
      ingress_fence_verified: phase !== 'accepted_255',
      release_identity_verified: migrated, https_ready: migrated,
    },
  }
  const publicKeyPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { plan, capture, journal, observation, publicKeyPem }
}

describe('read-only 254/255 transition review', () => {
  it('keeps every structurally valid signed phase review-only and non-deployable', () => {
    for (const phase of ['captured_254', 'fenced_254', 'migrating_255', 'verified_255',
      'candidate_cutover', 'accepted_255']) {
      const result = reviewBridge255Phase(fixture(phase))
      expect(result).toMatchObject({ phase, status: 'review_only', production_authorized: false,
        deployable: false })
      expect(result.blockers).toContain('NO_PROTECTED_NONCE_LEDGER_CONSUMER')
    }
  })

  it('rejects topology, public identity, migration history and frozen artifact drift', () => {
    const mutations = [
      (x: ReturnType<typeof fixture>) => { x.plan.project = 'merchant-production' },
      (x: ReturnType<typeof fixture>) => { x.capture.containers[0]!.name = 'wrong'; },
      (x: ReturnType<typeof fixture>) => { x.capture.public_release.release_id = 'release-foreign' },
      (x: ReturnType<typeof fixture>) => { x.observation.database.history_sha256 = h('7') },
      (x: ReturnType<typeof fixture>) => { x.plan.recovery_255.compose_sha256 = h('7') },
    ]
    for (const mutate of mutations) {
      const input = fixture()
      mutate(input)
      expect(() => reviewBridge255Phase(input)).toThrow()
    }
  })

  it('rejects altered signatures, nonce binding, expired journal and missing predecessor', () => {
    const altered = fixture(); altered.journal.signature_base64 = Buffer.alloc(64).toString('base64')
    expect(() => reviewBridge255Phase(altered)).toThrow('JOURNAL_SIGNATURE_INVALID')
    const nonce = fixture(); nonce.journal.nonce_sha256 = h('9')
    expect(() => reviewBridge255Phase(nonce)).toThrow('JOURNAL_IDENTITY_OR_TIME_INVALID')
    const expired = fixture(); expired.journal.expires_at = new Date(Date.now() - 1_000).toISOString()
    expect(() => reviewBridge255Phase(expired)).toThrow('JOURNAL_IDENTITY_OR_TIME_INVALID')
    const predecessor = fixture('fenced_254'); predecessor.journal.previous_journal_sha256 = null
    expect(() => reviewBridge255Phase(predecessor)).toThrow('JOURNAL_IDENTITY_OR_TIME_INVALID')
  })

  it('requires fence, drained workers, signed PG17 restore and 255 health before cutover', () => {
    for (const mutate of [
      (x: ReturnType<typeof fixture>) => { x.observation.ingress_fenced = false },
      (x: ReturnType<typeof fixture>) => { x.observation.active_outbox_leases = 1 },
      (x: ReturnType<typeof fixture>) => { x.observation.stopped_services.pop() },
      (x: ReturnType<typeof fixture>) => { x.observation.gateway!.ingress_fence_verified = false },
      (x: ReturnType<typeof fixture>) => { x.observation.backup!.signed = false },
    ]) {
      const input = fixture('fenced_254'); mutate(input)
      expect(() => reviewBridge255Phase(input)).toThrow()
    }
    const migrated = fixture('verified_255'); migrated.observation.runtime!.workers_ready = 4
    expect(() => reviewBridge255Phase(migrated)).toThrow('RUNTIME_255_NOT_VERIFIED')
    const openEarly = fixture('candidate_cutover'); openEarly.observation.ingress_fenced = false
    expect(() => reviewBridge255Phase(openEarly)).toThrow('FENCE_OR_DRAIN_INCOMPLETE')
  })
})
