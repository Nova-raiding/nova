import { describe, expect, it } from 'vitest'
import { FixedWindowQuotaAdmission, InMemoryQuotaCounterStore, InvalidQuotaInputError, QuotaExceededError, QuotaStateUnavailableError, type QuotaAdmissionInput, type QuotaCounterStore } from './admission.js'

describe('fixed-window quota admission', () => {
  it('admits up to the configured limit and exposes retry guidance', async () => {
    let now = 10_000
    const admission = new FixedWindowQuotaAdmission(new InMemoryQuotaCounterStore(() => now), () => now)
    const input = { tenantId: 'tenant-a', namespace: 'platform' as const, key: 'taobao:acct-1', limitPerWindow: 2, windowSeconds: 60 }
    await admission.admit(input)
    await admission.admit(input)
    await expect(admission.admit(input))
      .rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED', retryable: true, decision: { allowed: false, used: 3 } })
    now += 60_000
    await expect(admission.admit(input)).resolves.toMatchObject({ allowed: true, used: 1 })
  })

  it('keeps platform and model quota namespaces independent', async () => {
    const admission = new FixedWindowQuotaAdmission(new InMemoryQuotaCounterStore())
    await admission.admit({ tenantId: 'tenant-a', namespace: 'platform', key: 'jd:acct-1', limitPerWindow: 1 })
    await admission.admit({ tenantId: 'tenant-a', namespace: 'model', key: 'gpt-test', limitPerWindow: 1 })
    await expect(admission.admit({ tenantId: 'tenant-a', namespace: 'platform', key: 'jd:acct-1', limitPerWindow: 1 })).rejects.toBeInstanceOf(QuotaExceededError)
  })

  it('isolates identical resource keys between tenants', async () => {
    const admission = new FixedWindowQuotaAdmission(new InMemoryQuotaCounterStore())
    await admission.admit({ tenantId: 'tenant-a', namespace: 'platform', key: 'same-resource', limitPerWindow: 1 })
    await expect(admission.admit({ tenantId: 'tenant-b', namespace: 'platform', key: 'same-resource', limitPerWindow: 1 })).resolves.toMatchObject({ used: 1 })
  })

  it.each([
    ['missing tenant', { namespace: 'platform', key: 'resource', limitPerWindow: 1 }],
    ['empty tenant', { tenantId: '', namespace: 'platform', key: 'resource', limitPerWindow: 1 }],
    ['invalid limit', { tenantId: 'tenant-a', namespace: 'platform', key: 'resource', limitPerWindow: 0 }],
    ['fractional window', { tenantId: 'tenant-a', namespace: 'platform', key: 'resource', limitPerWindow: 1, windowSeconds: 1.5 }],
  ])('rejects %s without touching the counter', async (_name, input) => {
    let calls = 0
    const store: QuotaCounterStore = { increment: async () => { calls += 1; return 1 } }
    const admission = new FixedWindowQuotaAdmission(store)
    await expect(admission.admit(input as QuotaAdmissionInput)).rejects.toBeInstanceOf(InvalidQuotaInputError)
    expect(calls).toBe(0)
  })

  it('fails closed when the counter store is unavailable or corrupt', async () => {
    const unavailable: QuotaCounterStore = { increment: async () => { throw new Error('redis down') } }
    await expect(new FixedWindowQuotaAdmission(unavailable).admit({ tenantId: 'tenant-a', namespace: 'platform', key: 'resource', limitPerWindow: 1 }))
      .rejects.toMatchObject({ code: 'QUOTA_STATE_UNAVAILABLE', retryable: true, unknown: true })
    const corrupt: QuotaCounterStore = { increment: async () => 0 }
    await expect(new FixedWindowQuotaAdmission(corrupt).admit({ tenantId: 'tenant-a', namespace: 'platform', key: 'resource', limitPerWindow: 1 }))
      .rejects.toBeInstanceOf(QuotaStateUnavailableError)
  })
})
