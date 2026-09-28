import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { reviewBridge255Phase, validateBridge255Plan } from '../infra/protected/ecs-bridge-255-review.mjs'
import { reviewBridge255Transition, BRIDGE_255_HOST_CONTRACT } from '../infra/protected/ecs-bridge-255-state.mjs'

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

function fixture(phase = 'captured_254', candidateHasScan = false) {
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
    old_demo_services: [...services].sort(),
    recovery_255_services: [...services, ...(candidateHasScan ? ['worker-scan'] : [])].sort(),
    candidate_255_services: [...services, ...(candidateHasScan ? ['worker-scan'] : [])].sort(),
  }
  const prefix = (version: number) => ({ version, history_sha256: version === 254 ? h('1') : h('2'),
    ops_version: version, ops_history_sha256: version === 254 ? h('1') : h('2') })
  const captureBody = {
    project: plan.project, public_release: plan.bridge_254_255.identity, database: prefix(254),
    containers: services.map((service, index) => ({ service,
      name: `${plan.project}-${service}-1`, project: plan.project, compose_service: service,
      id: index.toString(16).padStart(64, '0'), image_id: `sha256:${(index + 16).toString(16).padStart(64, '0')}`,
      inspect_sha256: h('3'), network_sha256: h('4'), running: true })),
    gateway_ports: { http: 80, https: 443 },
    compose_services: plan.old_demo_services,
    compose_sha256: plan.bridge_254_255.compose_sha256,
  }
  const capture = { ...captureBody, capture_sha256: digest(captureBody) }
  const migrated = ['verified_255', 'candidate_cutover', 'accepted_255'].includes(phase)
  const observation = {
    phase, database: prefix(migrated ? 255 : 254), ingress_fenced: phase === 'captured_254' || phase === 'accepted_255' ? false : true,
    callbacks_fenced: phase === 'captured_254' || phase === 'accepted_255' ? false : true,
    in_flight_requests: 0, active_worker_cycles: 0, active_outbox_leases: 0,
    provider_started_unresolved: 0,
    stopped_services: phase === 'captured_254' || phase === 'accepted_255' ? [] : [...runtime],
    backup: phase === 'captured_254' ? null : { signed: true, pg17_image_ref: plan.pg17_image_ref,
      archive_sha256: h('6'), restored_prefix_version: 254, restored_prefix_sha256: h('1') },
    runtime: migrated ? { identity: phase === 'verified_255' ? plan.recovery_255.identity : plan.candidate_255.identity,
      services: phase === 'verified_255' ? plan.recovery_255_services : plan.candidate_255_services,
      api_ready: true, api_replica_ready: true,
      workers_ready: (phase === 'verified_255' ? plan.recovery_255_services : plan.candidate_255_services)
        .filter(name => name.startsWith('worker-')).length,
      business_canary_passed: true, ops_canary_passed: true,
      model_relay_passed: true, codex_stdio_host_passed: true } : null,
    gateway: phase === 'captured_254' ? null : {
      ingress_fence_verified: phase !== 'accepted_255',
      release_identity_verified: migrated, https_ready: migrated,
    },
  }
  const journalBody = { schema_version: 'ecs-bridge-255-journal/2', attempt_id: plan.attempt_id,
    plan_sha256: validateBridge255Plan(plan), phase,
    previous_journal_sha256: phase === 'captured_254' ? null : h('5'),
    nonce_sha256: plan.nonce_sha256, capture_sha256: capture.capture_sha256,
    observation_sha256: digest(observation), created_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString() }
  const journal = { ...journalBody,
    signature_base64: sign(null, Buffer.from(canonical(journalBody)), key.privateKey).toString('base64') }
  const publicKeyPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { plan, capture, journal, observation, publicKeyPem, privateKey: key.privateKey }
}

const signedJournalDigest = (journal: object) => createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.entries(journal).sort(([a], [b]) => a.localeCompare(b)))))
  .digest('hex')

function transitionFixture(from: string, to: string) {
  const previous = fixture(from)
  const nextObservation = fixture(to).observation
  const { signature_base64: _signature, ...body } = previous.journal
  const nextBody = { ...body, phase: to,
    observation_sha256: digest(nextObservation),
    previous_journal_sha256: signedJournalDigest(previous.journal),
    created_at: new Date(Date.parse(previous.journal.created_at) + 1_000).toISOString() }
  const next = { ...nextBody,
    signature_base64: sign(null, Buffer.from(canonical(nextBody)), previous.privateKey).toString('base64') }
  return { plan: previous.plan, capture: previous.capture,
    previous: previous.journal, next, publicKeyPem: previous.publicKeyPem,
    previousObservation: previous.observation, nextObservation, privateKey: previous.privateKey }
}

function resignNext(input: ReturnType<typeof transitionFixture>) {
  const { signature_base64: _signature, ...body } = input.next
  input.next.signature_base64 = sign(null, Buffer.from(canonical(body)), input.privateKey).toString('base64')
}

function resignObservation(input: ReturnType<typeof fixture>) {
  input.journal.observation_sha256 = digest(input.observation)
  const { signature_base64: _signature, ...body } = input.journal
  input.journal.signature_base64 = sign(null, Buffer.from(canonical(body)), input.privateKey).toString('base64')
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

  it('derives worker counts from separate frozen old and candidate Compose service sets', () => {
    const input = fixture('candidate_cutover', true)
    expect(input.plan.old_demo_services.filter(name => name.startsWith('worker-'))).toHaveLength(5)
    expect(input.plan.candidate_255_services.filter(name => name.startsWith('worker-'))).toHaveLength(6)
    expect(reviewBridge255Phase(input)).toMatchObject({ status: 'review_only', deployable: false })
    input.observation.runtime!.workers_ready = 5
    resignObservation(input)
    expect(() => reviewBridge255Phase(input)).toThrow('RUNTIME_255_NOT_VERIFIED')
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

  it('binds each signed journal phase to exact capture and observation bytes', () => {
    const changedCapture = fixture()
    changedCapture.capture.containers[0]!.name = 'changed'
    const { capture_sha256: _old, ...captureBody } = changedCapture.capture
    changedCapture.capture.capture_sha256 = digest(captureBody)
    expect(() => reviewBridge255Phase(changedCapture)).toThrow('JOURNAL_CAPTURE_BINDING_INVALID')

    const changedObservation = fixture()
    changedObservation.observation.in_flight_requests = 1
    expect(() => reviewBridge255Phase(changedObservation)).toThrow('JOURNAL_OBSERVATION_BINDING_INVALID')
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
    const migrated = fixture('verified_255'); migrated.observation.runtime!.workers_ready = 4; resignObservation(migrated)
    expect(() => reviewBridge255Phase(migrated)).toThrow('RUNTIME_255_NOT_VERIFIED')
    const openEarly = fixture('candidate_cutover'); openEarly.observation.ingress_fenced = false; resignObservation(openEarly)
    expect(() => reviewBridge255Phase(openEarly)).toThrow('FENCE_OR_DRAIN_INCOMPLETE')
    const noHost = fixture('accepted_255'); noHost.observation.runtime!.codex_stdio_host_passed = false; resignObservation(noHost)
    expect(() => reviewBridge255Phase(noHost)).toThrow('POST_CUTOVER_EVIDENCE_INCOMPLETE')
  })
})

describe('read-only 254/255 signed journal state machine', () => {
  it('reviews only adjacent phases and names the future protected host contract', () => {
    const phases = ['captured_254', 'fenced_254', 'migrating_255', 'verified_255',
      'candidate_cutover', 'accepted_255']
    for (let index = 1; index < phases.length; index += 1) {
      const result = reviewBridge255Transition(transitionFixture(phases[index - 1]!, phases[index]!))
      expect(result).toMatchObject({ from: phases[index - 1], to: phases[index],
        status: 'review_only', deployable: false, production_authorized: false })
      expect(result.host_contract.production_lock).toBe(BRIDGE_255_HOST_CONTRACT.production_lock)
      expect(result.required_observations.length).toBeGreaterThan(0)
      expect(result.blockers).toContain('NO_REHEARSED_FORWARD_RECOVERY_PATH')
    }
  })

  it('rejects skipped or repeated phases, altered signed predecessor, time extension and schema regression', () => {
    expect(() => reviewBridge255Transition(transitionFixture('captured_254', 'migrating_255')))
      .toThrow('PHASE_ORDER_INVALID')
    expect(() => reviewBridge255Transition(transitionFixture('fenced_254', 'fenced_254')))
      .toThrow('PHASE_ORDER_INVALID')
    const broken = transitionFixture('captured_254', 'fenced_254')
    broken.next.previous_journal_sha256 = h('8')
    resignNext(broken)
    expect(() => reviewBridge255Transition(broken)).toThrow('JOURNAL_CHAIN_INVALID')
    const extended = transitionFixture('captured_254', 'fenced_254')
    extended.next.expires_at = new Date(Date.parse(extended.next.expires_at) + 1_000).toISOString()
    resignNext(extended)
    expect(() => reviewBridge255Transition(extended)).toThrow('JOURNAL_CHRONOLOGY_INVALID')
    const otherNonce = transitionFixture('captured_254', 'fenced_254')
    otherNonce.next.nonce_sha256 = h('9')
    resignNext(otherNonce)
    expect(() => reviewBridge255Transition(otherNonce)).toThrow('JOURNAL_IDENTITY_OR_TIME_INVALID')
    const regression = transitionFixture('migrating_255', 'verified_255')
    regression.previousObservation.database.version = 255
    regression.previousObservation.database.history_sha256 = h('2')
    regression.previousObservation.database.ops_version = 255
    regression.previousObservation.database.ops_history_sha256 = h('2')
    regression.nextObservation.database.version = 254
    expect(() => reviewBridge255Transition(regression)).toThrow()
  })
})
