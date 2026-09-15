import { describe, expect, it, vi } from 'vitest'
import type { CustomerDelivery } from '../../../packages/persistence/src/customer-delivery-repository.js'
import { readCustomerDeliveryAccess as read, assertCustomerDeliveryAllowed as assertAllowed, pendingCustomerDeliveryProjection } from './customer-delivery-access.js'

describe('delivery access live evidence projection (controlled repository)', () => {
  const delivery = (effectiveAt: string | null) => ({ workspaceId: 'w', targetAccountId: 'a', targetIdentityId: 'i', effectiveAt }) as CustomerDelivery
  it('only a truly absent binding preserves legacy behavior', async () => {
    expect(await read({ getByIdentity: async () => null }, 'w', 'i')).toEqual({ state: 'unbound', allowed: true })
  })
  it('rechecks effective evidence for every request, including later revocation', async () => {
    const getByIdentity = vi.fn().mockResolvedValueOnce(delivery(null)).mockResolvedValueOnce(delivery('2026-09-15T00:00:00Z')).mockResolvedValueOnce(delivery(null))
    const repo = { getByIdentity }
    expect(() => assertAllowed({ state: 'pending', allowed: false })).toThrow(expect.objectContaining({ code: 'CUSTOMER_DELIVERY_REQUIRED', status: 403 }))
    expect(await read(repo, 'w', 'i')).toEqual({ state: 'pending', allowed: false })
    expect(await read(repo, 'w', 'i')).toEqual({ state: 'ready', allowed: true })
    expect(await read(repo, 'w', 'i')).toEqual({ state: 'pending', allowed: false })
    expect(getByIdentity.mock.calls).toEqual([['w', 'i'], ['w', 'i'], ['w', 'i']])
  })
  it.each(['42501', '42P01', 'timeout'])('fails closed on %s without leaking database or evidence details', async code => {
    await expect(read({ getByIdentity: async () => { throw new Error(`${code}: secret payment proof`) } }, 'w', 'i')).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE', status: 503 })
  })
  it.each([{ workspaceId: 'other' }, { targetIdentityId: 'other' }, { targetAccountId: null }])('rejects malformed identity projection %j', async patch => {
    await expect(read({ getByIdentity: async () => ({ ...delivery('2026-09-15'), ...patch }) }, 'w', 'i')).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE' })
  })
  it('requires a trusted workspace and identity and emits no account/proof identifiers', async () => {
    const getByIdentity = vi.fn()
    for (const args of [['', 'i'], ['w', '']]) await expect(read({ getByIdentity }, args[0]!, args[1]!)).rejects.toMatchObject({ code: 'CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE' })
    expect(getByIdentity).not.toHaveBeenCalled()
    const view = pendingCustomerDeliveryProjection({ state: 'pending', allowed: false })
    expect(view.business_access.allowed).toBe(false)
    expect(JSON.stringify(view)).not.toMatch(/targetAccount|targetIdentity|contractRef|paymentEvidence|catalog.search|content.generate|publish.confirm/)
  })
})
