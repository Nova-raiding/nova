import { describe, expect, it } from 'vitest'
import { FeatureFlagRepositoryError, MemoryFeatureFlagsRepository, featureFlagBucket } from './feature-flags-repository.js'

const create = (overrides: Record<string, unknown> = {}) => ({
  key: 'checkout.new_flow', environment: 'production', description: 'New checkout flow',
  defaultValue: { type: 'boolean' as const, value: true }, enabled: true, targets: [],
  actorId: 'ops-1', reason: 'initial controlled rollout', idempotencyKey: 'create-flag-0001', ...overrides,
})

describe('feature flags repository', () => {
  it('defaults safely, applies deterministic precedence, and emergency disable wins', async () => {
    const repository = new MemoryFeatureFlagsRepository()
    expect(await repository.evaluate({ flagKey: 'missing', environment: 'production' })).toMatchObject({ enabled: false, matchedBy: 'missing' })
    const saved = await repository.save(create({ targets: [
      { type: 'workspace', value: 'ws-deny', enabled: false },
      { type: 'identity', value: 'user-allow', enabled: true },
      { type: 'percentage', value: '10000', enabled: true },
    ] }))
    expect(await repository.evaluate({ flagKey: 'checkout.new_flow', environment: 'production', identityId: 'user-allow', workspaceId: 'ws-deny' })).toMatchObject({ enabled: true, matchedBy: 'identity' })
    expect(await repository.evaluate({ flagKey: 'checkout.new_flow', environment: 'production', workspaceId: 'ws-deny' })).toMatchObject({ enabled: false, matchedBy: 'workspace' })
    expect(await repository.evaluate({ flagKey: 'checkout.new_flow', environment: 'production', bucketSubject: 'stable-user' })).toMatchObject({ enabled: true, matchedBy: 'percentage' })
    const stopped = await repository.setEmergency({ id: saved.flag.id, disabled: true, expectedRevision: 1, actorId: 'root', reason: 'production incident stop', idempotencyKey: 'emergency-stop-01' })
    expect(await repository.evaluate({ flagKey: 'checkout.new_flow', environment: 'production', identityId: 'user-allow' })).toMatchObject({ enabled: false, matchedBy: 'emergency', revision: stopped.flag.revision })
  })

  it('protects optimistic revisions and idempotent intent', async () => {
    const repository = new MemoryFeatureFlagsRepository()
    const first = await repository.save(create())
    const replay = await repository.save(create())
    expect(replay).toEqual({ flag: first.flag, replayed: true })
    await expect(repository.save(create({ idempotencyKey: 'create-flag-0001', description: 'changed intent' }))).rejects.toMatchObject({ code: 'FEATURE_FLAG_IDEMPOTENCY_CONFLICT' })
    await expect(repository.save(create({ id: first.flag.id, expectedRevision: 99, idempotencyKey: 'update-flag-0002' }))).rejects.toMatchObject({ code: 'FEATURE_FLAG_REVISION_CONFLICT' })
    expect(await repository.listEvents(first.flag.id)).toHaveLength(1)
  })

  it('uses stable cursor pagination and environment filtering', async () => {
    const repository = new MemoryFeatureFlagsRepository()
    for (let index = 0; index < 4; index += 1) await repository.save(create({ key: `flag.${index}`, environment: index === 3 ? 'staging' : 'production', idempotencyKey: `create-page-${index}` }))
    const first = await repository.list({ environment: 'production', limit: 2 })
    const second = await repository.list({ environment: 'production', limit: 2, cursor: first.nextCursor })
    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(1)
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(3)
    await expect(repository.list({ cursor: 'invalid' })).rejects.toBeInstanceOf(FeatureFlagRepositoryError)
  })

  it('keeps percentage buckets deterministic', () => {
    expect(featureFlagBucket('flag', 'production', 'subject')).toBe(featureFlagBucket('flag', 'production', 'subject'))
    expect(featureFlagBucket('flag', 'production', 'subject')).toBeGreaterThanOrEqual(0)
    expect(featureFlagBucket('flag', 'production', 'subject')).toBeLessThan(10000)
  })
})
