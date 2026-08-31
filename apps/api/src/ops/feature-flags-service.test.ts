import { describe, expect, it } from 'vitest'
import { MemoryFeatureFlagsRepository } from '../../../../packages/persistence/src/feature-flags-repository.js'
import { FeatureFlagAuthorizationError, FeatureFlagsService } from './feature-flags-service.js'

const input = { key: 'search.semantic', environment: 'production', description: 'Semantic search', defaultValue: { type: 'boolean' as const, value: true }, reason: 'controlled release', idempotencyKey: 'semantic-create-01' }

describe('FeatureFlagsService', () => {
  it('enforces read/write/emergency RBAC', async () => {
    const service = new FeatureFlagsService(new MemoryFeatureFlagsRepository())
    await expect(service.save({ id: 'member', roles: ['member'] }, input)).rejects.toBeInstanceOf(FeatureFlagAuthorizationError)
    const saved = await service.save({ id: 'ops', roles: ['ops_admin'] }, input)
    await expect(service.setEmergency({ id: 'ops', roles: ['ops_admin'] }, { id: saved.flag.id, disabled: true, expectedRevision: 1, reason: 'incident response', idempotencyKey: 'incident-stop-01' })).rejects.toBeInstanceOf(FeatureFlagAuthorizationError)
    await expect(service.setEmergency({ id: 'root', roles: ['platform_admin'] }, { id: saved.flag.id, disabled: true, expectedRevision: 1, reason: 'incident response', idempotencyKey: 'incident-stop-01' })).resolves.toMatchObject({ flag: { emergencyDisabled: true } })
  })

  it('defaults new flags to disabled and validates non-executable typed values', async () => {
    const service = new FeatureFlagsService(new MemoryFeatureFlagsRepository())
    const saved = await service.save({ id: 'ops', roles: ['ops_admin'] }, input)
    expect(saved.flag.enabled).toBe(false)
    await expect(service.save({ id: 'ops', roles: ['ops_admin'] }, { ...input, key: 'bad.value', idempotencyKey: 'bad-value-0001', defaultValue: { type: 'number', value: 'script()' as never } })).rejects.toMatchObject({ code: 'FEATURE_FLAG_VALUE_TYPE_MISMATCH' })
    await expect(service.save({ id: 'ops', roles: ['ops_admin'] }, { ...input, key: 'large.value', idempotencyKey: 'large-value-001', defaultValue: { type: 'string', value: 'x'.repeat(17 * 1024) } })).rejects.toMatchObject({ code: 'FEATURE_FLAG_VALUE_TOO_LARGE' })
    await expect(service.save({ id: 'ops', roles: ['ops_admin'] }, { ...input, key: 'bad.window', idempotencyKey: 'bad-window-0001', validFrom: '2027-01-01T00:00:00Z', validTo: '2026-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'FEATURE_FLAG_VALIDITY_INVALID' })
  })

  it('prevents tenant callers from evaluating another workspace or identity', async () => {
    const service = new FeatureFlagsService(new MemoryFeatureFlagsRepository())
    await expect(service.evaluate({ id: 'user-a', roles: ['member'], workspaceIds: ['ws-a'] }, { flagKey: 'x', environment: 'production', workspaceId: 'ws-b' })).rejects.toBeInstanceOf(FeatureFlagAuthorizationError)
    await expect(service.evaluate({ id: 'user-a', roles: ['member'], workspaceIds: ['ws-a'] }, { flagKey: 'x', environment: 'production', identityId: 'user-b' })).rejects.toBeInstanceOf(FeatureFlagAuthorizationError)
    await expect(service.evaluate({ id: 'user-a', roles: ['member'], workspaceIds: ['ws-a'] }, { flagKey: 'x', environment: 'production', workspaceId: 'ws-a' })).resolves.toMatchObject({ enabled: false, matchedBy: 'missing' })
  })

  it('does not trust client-supplied target row identifiers', async () => {
    const service = new FeatureFlagsService(new MemoryFeatureFlagsRepository())
    const saved = await service.save({ id: 'ops', roles: ['ops_admin'] }, { ...input, key: 'target.ids', idempotencyKey: 'target-id-create', targets: [{ id: 'borrowed-row-id', type: 'workspace', value: 'ws-a', enabled: true }] })
    expect(saved.flag.targets[0]?.id).toBeTruthy()
    expect(saved.flag.targets[0]?.id).not.toBe('borrowed-row-id')
  })
})
