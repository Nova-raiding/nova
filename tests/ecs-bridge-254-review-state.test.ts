import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BRIDGE_254_REVIEW_PHASES, reviewBridge254NextPhase, reviewBridge254SignedJournal } from '../infra/protected/ecs-bridge-254-review-state.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const digit = (value: string) => value.repeat(64)
const old_runtime = { release_id: 'old-242', git_sha: 'a'.repeat(40), manifest_sha256: digit('1'), image_set_digest: `sha256:${digit('2')}` }
const bridge = { release_id: 'bridge-254', git_sha: 'b'.repeat(40), manifest_sha256: digit('3'), image_set_digest: `sha256:${digit('4')}` }
const candidate = { release_id: 'candidate-c', git_sha: 'c'.repeat(40), manifest_sha256: digit('5'), image_set_digest: `sha256:${digit('6')}` }
const nonce = 'nonce_242_254_bridge_attempt_1234567890'
const attempt = 'attempt_bridge_254_123456'
const prefixes = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [String(242 + index), hash(`prefix-${242 + index}`)]))
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const nonceOwner = { namespace: 'merchant-production-deploy', operation: 'bridge-254', attempt_id: attempt, ...bridge, nonce_sha256: hash(nonce) }
const expected = { candidate, bridge, old_runtime, deploymentNonce: nonce, recoveryCapsuleSha256: digit('7'), trustedKeyId: 'protected-key-v1', publicKeyPem, nonceOwner }
const now = new Date('2026-09-27T12:00:00.000Z')
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value)

function journal(phase = 'captured', version = 242) {
  const body = {
    schema_version: 'ecs-bridge-254-review-journal/1', purpose: 'bridge_242_to_254_review', phase,
    attempt_id: attempt, key_id: 'protected-key-v1', created_at: '2026-09-27T11:00:00.000Z',
    updated_at: '2026-09-27T11:30:00.000Z', expires_at: '2026-09-28T11:00:00.000Z',
    compose_project: 'merchant-production', candidate, bridge, old_runtime,
    deployment_nonce_sha256: hash(nonce), recovery_capsule_sha256: digit('7'), baseline_inventory_sha256: digit('8'),
    allowed_prefix_sha256: { ...prefixes }, database_prefix: { version, history_sha256: prefixes[version] },
    nonce_owner: phase === 'captured' ? null : { ...nonceOwner },
    deployable: false,
  }
  return { ...body, signature_base64: sign(null, Buffer.from(canonical(body)), privateKey).toString('base64') }
}
const observation = (version: number) => ({ version, history_sha256: prefixes[version] })
const next = (phase: string, to: string, version: number) => reviewBridge254NextPhase(journal(phase, version), to, observation(version), expected, now)

describe('review-only 242→254 signed bridge state contract', () => {
  it('validates a signed shape while never authorizing deployment or claiming protected provenance', () => {
    expect(reviewBridge254SignedJournal(journal(), expected, now)).toMatchObject({
      status: 'review_only', structure_consistent: true, cryptographic_signature_valid: true,
      nonce_ledger_verified: false, database_observation_verified: false, deployable: false, errors: [],
    })
  })

  it('refuses tampering, wrong trust, replayed nonce ownership, and extra fields', () => {
    const changed = { ...journal(), compose_project: 'other' }
    expect(reviewBridge254SignedJournal(changed, expected, now).structure_consistent).toBe(false)
    expect(reviewBridge254SignedJournal(journal(), { ...expected, deploymentNonce: 'other_nonce_242_254_bridge_123456789' }, now).structure_consistent).toBe(false)
    expect(reviewBridge254NextPhase(journal(), 'nonce_consumed', observation(242), { ...expected, nonceOwner: undefined }, now).next_phase).toBeNull()
    const owner = journal('nonce_consumed')
    owner.nonce_owner!.operation = 'bridge-b'
    expect(reviewBridge254SignedJournal(owner, expected, now).structure_consistent).toBe(false)
    expect(reviewBridge254SignedJournal({ ...journal(), approved: true }, expected, now).structure_consistent).toBe(false)
  })

  it('requires the one-use nonce phase before bridge mutation at exact 242', () => {
    expect(next('captured', 'nonce_consumed', 242).next_phase).toBe('nonce_consumed')
    expect(next('captured', 'bridge_mutation_started', 242).next_phase).toBeNull()
    expect(next('nonce_consumed', 'bridge_mutation_started', 242).next_phase).toBe('bridge_mutation_started')
    expect(next('nonce_consumed', 'bridge_mutation_started', 243).next_phase).toBeNull()
  })

  it('allows old-runtime recovery only at 242', () => {
    expect(next('bridge_mutation_started', 'old_recovery_started', 242).next_phase).toBe('old_recovery_started')
    expect(next('bridge_verified', 'old_recovery_started', 242).next_phase).toBe('old_recovery_started')
    expect(next('migration_started', 'old_recovery_started', 243).next_phase).toBeNull()
    expect(next('migration_started', 'old_recovery_started', 254).next_phase).toBeNull()
  })

  it('permits every 243–253 interruption only to enter forward recovery', () => {
    for (let version = 243; version <= 253; version += 1) {
      expect(next('migration_started', 'forward_recovery_started', version).next_phase).toBe('forward_recovery_started')
      expect(next('migration_started', 'migration_254_verified', version).next_phase).toBeNull()
      expect(next('migration_started', 'old_recovery_started', version).next_phase).toBeNull()
    }
    expect(next('migration_started', 'forward_recovery_started', 242).next_phase).toBeNull()
    expect(next('migration_started', 'forward_recovery_started', 254).next_phase).toBeNull()
  })

  it('requires exact 254 before declaring migration phase complete', () => {
    expect(next('migration_started', 'migration_254_verified', 254).next_phase).toBe('migration_254_verified')
    expect(next('forward_recovery_started', 'migration_254_verified', 254).next_phase).toBe('migration_254_verified')
    expect(next('forward_recovery_started', 'migration_254_verified', 253).next_phase).toBeNull()
    expect(BRIDGE_254_REVIEW_PHASES.migration_254_verified).toEqual([])
  })

  it('rejects a caller supplied prefix outside the frozen chain', () => {
    const signed = journal('migration_started', 243)
    const result = reviewBridge254NextPhase(signed, 'forward_recovery_started', { version: 243, history_sha256: digit('f') }, expected, now)
    expect(result.next_phase).toBeNull()
    expect(result.database_observation_verified).toBe(false)
    const regressed = reviewBridge254NextPhase(journal('migration_started', 254), 'forward_recovery_started', observation(253), expected, now)
    expect(regressed.next_phase).toBeNull()
  })

  it('rejects signed phases that claim an impossible database prefix', () => {
    expect(reviewBridge254SignedJournal(journal('bridge_verified', 243), expected, now).structure_consistent).toBe(false)
    expect(reviewBridge254SignedJournal(journal('old_recovery_started', 254), expected, now).structure_consistent).toBe(false)
    expect(reviewBridge254SignedJournal(journal('migration_254_verified', 253), expected, now).structure_consistent).toBe(false)
  })
})
