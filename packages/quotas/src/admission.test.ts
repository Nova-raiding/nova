import { describe, expect, it } from 'vitest'
import { FixedWindowQuotaAdmission, InMemoryQuotaCounterStore, QuotaExceededError } from './admission.js'

describe('fixed-window quota admission', () => {
  it('admits up to the configured limit and exposes retry guidance', async () => {
    let now = 10_000
    const admission = new FixedWindowQuotaAdmission(new InMemoryQuotaCounterStore(() => now), () => now)
    await admission.admit({ namespace: 'platform', key: 'taobao:acct-1', limitPerWindow: 2, windowSeconds: 60 })
    await admission.admit({ namespace: 'platform', key: 'taobao:acct-1', limitPerWindow: 2, windowSeconds: 60 })
    await expect(admission.admit({ namespace: 'platform', key: 'taobao:acct-1', limitPerWindow: 2, windowSeconds: 60 }))
      .rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED', retryable: true, decision: { allowed: false, used: 3 } })
    now += 60_000
    await expect(admission.admit({ namespace: 'platform', key: 'taobao:acct-1', limitPerWindow: 2, windowSeconds: 60 })).resolves.toMatchObject({ allowed: true, used: 1 })
  })

  it('keeps platform and model quota namespaces independent', async () => {
    const admission = new FixedWindowQuotaAdmission(new InMemoryQuotaCounterStore())
    await admission.admit({ namespace: 'platform', key: 'jd:acct-1', limitPerWindow: 1 })
    await admission.admit({ namespace: 'model', key: 'gpt-test', limitPerWindow: 1 })
    await expect(admission.admit({ namespace: 'platform', key: 'jd:acct-1', limitPerWindow: 1 })).rejects.toBeInstanceOf(QuotaExceededError)
  })
})
