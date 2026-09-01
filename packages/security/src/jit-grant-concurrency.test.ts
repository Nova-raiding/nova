import { describe, expect, it } from 'vitest'
import { LocalJitGrantStore } from './jit-grant-concurrency.js'

const input = (overrides: Partial<Parameters<LocalJitGrantStore['issue']>[0]> = {}) => ({
  actorId: 'operator-1', workspaceId: 'workspace-1', capability: 'customer.content.read', scopeHash: 'scope-a', issuedAt: 1_000, expiresAt: 2_000, maxUses: 1, ...overrides,
})

describe('local JIT grant concurrency boundary', () => {
  it('linearizes concurrent max-use consumption without overselling', async () => {
    const store = new LocalJitGrantStore({ idFactory: () => 'grant-max-use' })
    const grant = await store.issue(input({ maxUses: 3 }))
    const decisions = await Promise.all(Array.from({ length: 32 }, () => store.consume({ id: grant.id, actorId: 'operator-1', workspaceId: 'workspace-1', capability: 'customer.content.read', scopeHash: 'scope-a', at: 1_500 })))
    expect(decisions.filter(decision => decision.allowed)).toHaveLength(3)
    expect(new Set(decisions.filter(decision => !decision.allowed).map(decision => decision.reason))).toEqual(new Set(['max_uses']))
    expect((await store.get(grant.id))?.useCount).toBe(3)
  })

  it('makes revoke and concurrent consumption a single linearized decision', async () => {
    const store = new LocalJitGrantStore({ idFactory: () => 'grant-revoke' })
    const grant = await store.issue(input({ maxUses: 32 }))
    const decisions = await Promise.all([
      store.revoke({ id: grant.id, actorId: 'operator-1', at: 1_200 }),
      ...Array.from({ length: 31 }, () => store.consume({ id: grant.id, actorId: 'operator-1', workspaceId: 'workspace-1', capability: 'customer.content.read', scopeHash: 'scope-a', at: 1_500 })),
    ])
    expect(decisions.filter(decision => decision.allowed && decision.grant?.useCount !== undefined).length).toBeLessThanOrEqual(31)
    const final = await store.get(grant.id)
    expect(final?.revokedAt).toBe(1_200)
    expect(final?.useCount).toBeLessThanOrEqual(31)
    const afterRevoke = await store.consume({ id: grant.id, actorId: 'operator-1', workspaceId: 'workspace-1', capability: 'customer.content.read', scopeHash: 'scope-a', at: 1_501 })
    expect(afterRevoke).toMatchObject({ allowed: false, reason: 'revoked' })
  })

  it('rejects every concurrent consume at the expiry boundary', async () => {
    let now = 1_999
    const store = new LocalJitGrantStore({ now: () => now, idFactory: () => 'grant-expiry' })
    const grant = await store.issue(input({ maxUses: 32 }))
    now = 2_000
    const decisions = await Promise.all(Array.from({ length: 16 }, () => store.consume({ id: grant.id, actorId: 'operator-1', workspaceId: 'workspace-1', capability: 'customer.content.read', scopeHash: 'scope-a' })))
    expect(decisions.every(decision => decision.reason === 'expired')).toBe(true)
    expect((await store.get(grant.id))?.useCount).toBe(0)
  })

  it('rejects scope mismatch concurrently without consuming the grant', async () => {
    const store = new LocalJitGrantStore({ idFactory: () => 'grant-scope' })
    const grant = await store.issue(input({ maxUses: 4 }))
    const decisions = await Promise.all(Array.from({ length: 12 }, (_, index) => store.consume({ id: grant.id, actorId: 'operator-1', workspaceId: index % 2 ? 'workspace-2' : 'workspace-1', capability: index % 2 ? 'customer.content.update' : 'customer.content.read', scopeHash: 'scope-b', at: 1_500 })))
    expect(decisions.every(decision => decision.reason === 'scope_mismatch')).toBe(true)
    expect((await store.get(grant.id))?.useCount).toBe(0)
  })
})
