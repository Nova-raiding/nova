import { describe, expect, it } from 'vitest'
import { BRIDGE_254_RUNTIME_SERVICES, reviewBridge254CapsuleShape } from '../infra/protected/review-ecs-bridge-254-capsule.mjs'

const sha = (digit: string) => digit.repeat(64)
const candidate = { release_id: 'candidate-c', git_sha: 'a'.repeat(40), manifest_sha256: sha('b'), image_set_digest: `sha256:${sha('c')}` }
const bridge = { release_id: 'bridge-254', git_sha: 'd'.repeat(40), manifest_sha256: sha('e'), image_set_digest: `sha256:${sha('f')}` }
const now = new Date('2026-09-27T12:00:00.000Z')
const prefixes = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [String(242 + index), sha(String((index + 1) % 10))]))

function fixture() {
  return {
    schema_version: '1', kind: 'ecs-compose-rollback-capsule',
    created_at: '2026-09-27T11:00:00.000Z', expires_at: '2026-09-28T11:00:00.000Z',
    compose_project: 'merchant-production', current: { ...candidate },
    target: { ...bridge, compose_sha256: sha('1'), env_sha256: sha('2'), image_digests_sha256: sha('3'), services: [...BRIDGE_254_RUNTIME_SERVICES] },
    database: { strategy: 'forward_only', schema_downgrade: false, live_migration_version: 242, target_migration_tail: 254, allowed_prefix_sha256: { ...prefixes } },
    volumes: { preserve: true },
  }
}
const expected = { candidate, bridge, observedPrefix: { version: 242, historySha256: prefixes['242'] } }
const review = (document: unknown, observation: unknown = expected) => reviewBridge254CapsuleShape(document, observation, now)

describe('review-only 242→254 bridge capsule shape', () => {
  it('recognizes a fully specified shape without ever declaring deployability or provenance', () => {
    const result = review(fixture())
    expect(result.errors).toEqual([])
    expect(result).toMatchObject({ status: 'review_only', structure_consistent: true, deployable: false,
      signature_verified: false, runtime_verified: false, source_provenance_verified: false })
  })

  it('refuses omitted or invented fields and untrusted identities', () => {
    expect(review(null).structure_consistent).toBe(false)
    expect(review({ ...fixture(), approved: true }).structure_consistent).toBe(false)
    expect(review(fixture(), null).structure_consistent).toBe(false)
    expect(review({ ...fixture(), current: { ...candidate, release_id: 'other' } }).structure_consistent).toBe(false)
    expect(review({ ...fixture(), target: { ...fixture().target, image_digests_sha256: sha('x') } }).structure_consistent).toBe(false)
  })

  it('refuses an unsafe validity period or mutable project', () => {
    expect(review({ ...fixture(), expires_at: '2026-09-29T11:00:00.000Z' }).structure_consistent).toBe(false)
    expect(review({ ...fixture(), compose_project: 'other-project' }).structure_consistent).toBe(false)
  })

  it('requires the exact eight runtime services', () => {
    for (const services of [BRIDGE_254_RUNTIME_SERVICES.slice(1), [...BRIDGE_254_RUNTIME_SERVICES, 'migrate'],
      [...BRIDGE_254_RUNTIME_SERVICES.slice(1), 'api-replica']]) {
      const document = fixture()
      document.target.services = [...services]
      expect(review(document).errors).toContain('bridge target must contain exactly API, replica, and six workers')
    }
  })

  it('blocks schema downgrade, incomplete 242–254 prefixes, and observed-prefix drift', () => {
    for (const database of [
      { ...fixture().database, strategy: 'restore_backup' },
      { ...fixture().database, schema_downgrade: true },
      { ...fixture().database, target_migration_tail: 242 },
      { ...fixture().database, allowed_prefix_sha256: { 242: prefixes['242'], 254: prefixes['254'] } },
      { ...fixture().database, live_migration_version: 243 },
    ]) {
      expect(review({ ...fixture(), database }).structure_consistent).toBe(false)
    }
    expect(review(fixture(), { ...expected, observedPrefix: { version: 242, historySha256: sha('9') } }).structure_consistent).toBe(false)
  })

  it('rejects changing the bridge artifact bytes or preserving volumes only by default', () => {
    const document = fixture()
    document.target.compose_sha256 = ''
    expect(review(document).structure_consistent).toBe(false)
    expect(review({ ...fixture(), volumes: {} }).structure_consistent).toBe(false)
  })
})
