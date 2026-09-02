import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES, defineCommercialOperationRegistry } from '@merchant-marketing/contracts'
import {
  CommercialAccessService,
  type ApprovedCreativePointRate,
  type CreativePointBalanceProjection,
} from './commercial-access-service.js'

const registry = defineCommercialOperationRegistry([
  { surface: 'MCP', operation: 'subscription.get', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'MCP', operation: 'merchant.start', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_REQUIRED_NO_CHARGE', rate_action: null },
  { surface: 'MCP', operation: 'catalog.image.generate', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_CHARGED', rate_action: 'catalog.image.generate' },
  { surface: 'MCP', operation: 'content.generate', domain: 'COMMERCIAL', enabled: false, classification: 'POINT_CHARGED', rate_action: 'content.generate' },
  { surface: 'HTTP', operation: 'http:GET:/healthz', domain: 'MACHINE_INFRASTRUCTURE', enabled: true, classification: null, rate_action: null },
] as const)

function harness(
  balance: CreativePointBalanceProjection,
  rate: ApprovedCreativePointRate = { state: 'approved', quoted_points: 1, rate_card_version: 'rate-v1' },
  trace: { readonly id_factory?: () => string; readonly now?: () => Date } = {},
  entitlement: 'available' | 'missing' | 'unavailable' = 'available',
) {
  const projectCreativePointBalance = vi.fn(async () => balance)
  const resolveApprovedRate = vi.fn(async () => rate)
  const listV2EntitlementSnapshots = vi.fn(async () => {
    if (entitlement === 'unavailable') throw new Error('entitlement projection unavailable')
    if (entitlement === 'missing') return []
    return [{
      id: 'entitlement-v2-1', workspaceId: 'workspace-1', subscriptionPeriodId: 'period-1',
      periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2027-01-01T00:00:00.000Z', periodStatus: 'active',
      catalogVersionId: 'catalog-v1', skuCode: 'monthly_basic',
      resolvedBenefits: [{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }],
      unresolvedBlockers: [], executable: true, checksum: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z',
    }]
  })
  const service = new CommercialAccessService({
    registry,
    registry_version: 'registry-v1',
    balance_projection: { projectCreativePointBalance },
    rate_resolver: { resolveApprovedRate },
    entitlement_projection: { listV2EntitlementSnapshots },
    next_actions: code => code === ERROR_CODES.CREATIVE_POINTS_EXHAUSTED ? ['billing.status', 'billing.status'] : [],
    ...trace,
  })
  return { service, projectCreativePointBalance, resolveApprovedRate, listV2EntitlementSnapshots }
}

const request = (operation: string) => ({ surface: 'MCP' as const, operation, workspace_id: 'workspace-1' })
const decision = async (service: CommercialAccessService, operation: string, required_access_revision?: string) => {
  const result = await service.decide({ ...request(operation), required_access_revision })
  expect(result.outcome).toBe('DECISION')
  if (result.outcome !== 'DECISION') throw new Error(`expected decision, received ${result.outcome}`)
  return result.decision
}

describe('CommercialAccessService E1', () => {
  it('generates an authoritative decision identity and timestamp for every outcome', async () => {
    let sequence = 0
    const idFactory = vi.fn(() => `decision-${++sequence}`)
    const now = vi.fn(() => new Date(`2026-09-01T14:00:0${sequence}.000Z`))
    const h = harness(
      { state: 'known', available_points: 1, access_revision: 'r1', freshness: 'fresh' },
      { state: 'approved', quoted_points: 1, rate_card_version: 'rate-v1' },
      { id_factory: idFactory, now },
    )

    const results = [
      await h.service.decide(request('subscription.get')),
      await h.service.decide(request('merchant.start')),
      await h.service.decide(request('content.generate')),
      await h.service.decide(request('unknown.operation')),
      await h.service.decide({ surface: 'HTTP', operation: 'http:GET:/healthz', workspace_id: 'workspace-1' }),
    ]

    expect(results.map(result => result.decision_id)).toEqual([
      'decision-1', 'decision-2', 'decision-3', 'decision-4', 'decision-5',
    ])
    expect(results.map(result => result.decided_at)).toEqual([
      '2026-09-01T14:00:01.000Z',
      '2026-09-01T14:00:02.000Z',
      '2026-09-01T14:00:03.000Z',
      '2026-09-01T14:00:04.000Z',
      '2026-09-01T14:00:05.000Z',
    ])
    for (const result of results) {
      if (result.outcome === 'DECISION') {
        expect(result.decision).toMatchObject({ decision_id: result.decision_id, decided_at: result.decided_at })
      }
    }
    expect(idFactory).toHaveBeenCalledTimes(results.length)
    expect(now).toHaveBeenCalledTimes(results.length)
  })

  it('defaults to UUID decision ids and canonical ISO timestamps', async () => {
    const h = harness({ state: 'unknown' })
    const result = await h.service.decide(request('merchant.start'))
    expect(result.decision_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(result.decided_at).toBe(new Date(result.decided_at).toISOString())
  })

  it('allows an exact recovery control without consulting balance or rate ports', async () => {
    const h = harness({ state: 'unknown' }, { state: 'unavailable' })
    expect(await decision(h.service, 'subscription.get')).toMatchObject({
      classification: 'RECOVERY_CONTROL', balance_state: 'unknown', available_points: null, allowed: true, error_code: null,
    })
    expect(h.projectCreativePointBalance).not.toHaveBeenCalled()
    expect(h.resolveApprovedRate).not.toHaveBeenCalled()
  })

  it('fails disabled, unclassified, and non-commercial operations closed before reading points', async () => {
    const h = harness({ state: 'known', available_points: 50, access_revision: 'r1', freshness: 'fresh' })
    await expect(h.service.decide(request('content.generate'))).resolves.toMatchObject({ outcome: 'DENY_DISABLED' })
    await expect(h.service.decide(request('unknown.operation'))).resolves.toMatchObject({ outcome: 'DENY_UNCLASSIFIED', policy: null })
    await expect(h.service.decide({ surface: 'HTTP', operation: 'http:GET:/healthz', workspace_id: 'workspace-1' })).resolves.toMatchObject({ outcome: 'DENY_NON_COMMERCIAL' })
    expect(h.projectCreativePointBalance).not.toHaveBeenCalled()
    expect(h.resolveApprovedRate).not.toHaveBeenCalled()
  })

  it('preserves unknown balance as null and maps projection failures to unavailable', async () => {
    const h = harness({ state: 'unknown' })
    expect(await decision(h.service, 'merchant.start')).toMatchObject({
      balance_state: 'unknown', available_points: null, access_revision: null, allowed: false,
      error_code: ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE,
    })
    h.projectCreativePointBalance.mockRejectedValueOnce(new Error('projection unavailable'))
    expect(await decision(h.service, 'merchant.start')).toMatchObject({
      balance_state: 'unknown', available_points: null, error_code: ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE,
    })
  })

  it('blocks every business class at zero without resolving a charged rate', async () => {
    const h = harness({ state: 'known', available_points: 0, access_revision: 'r0', freshness: 'fresh' }, { state: 'unavailable' })
    expect(await decision(h.service, 'merchant.start')).toMatchObject({
      available_points: 0, quoted_points: null, allowed: false, error_code: ERROR_CODES.CREATIVE_POINTS_EXHAUSTED,
      next_actions: ['billing.status'],
    })
    expect(await decision(h.service, 'catalog.image.generate')).toMatchObject({
      available_points: 0, quoted_points: null, rate_card_version: null, allowed: false,
      error_code: ERROR_CODES.CREATIVE_POINTS_EXHAUSTED,
    })
    expect(h.resolveApprovedRate).not.toHaveBeenCalled()
  })

  it('allows positive no-charge access but denies stale revisions without a quote', async () => {
    const fresh = harness({ state: 'known', available_points: 1, access_revision: 'r2', freshness: 'fresh' })
    expect(await decision(fresh.service, 'merchant.start', 'r2')).toMatchObject({
      classification: 'POINT_REQUIRED_NO_CHARGE', quoted_points: null, allowed: true, error_code: null,
    })
    expect(await decision(fresh.service, 'merchant.start', 'older')).toMatchObject({
      quoted_points: null, allowed: false, error_code: ERROR_CODES.COMMERCIAL_ACCESS_STALE,
    })
    expect(fresh.resolveApprovedRate).not.toHaveBeenCalled()
  })

  it('consults V2 entitlement only after creative points pass and fails closed without it', async () => {
    const zero = harness({ state: 'known', available_points: 0, access_revision: 'r0', freshness: 'fresh' }, undefined, {}, 'unavailable')
    expect(await decision(zero.service, 'merchant.start')).toMatchObject({ error_code: ERROR_CODES.CREATIVE_POINTS_EXHAUSTED })
    expect(zero.listV2EntitlementSnapshots).not.toHaveBeenCalled()

    const missing = harness({ state: 'known', available_points: 1, access_revision: 'r1', freshness: 'fresh' }, undefined, {}, 'missing')
    const missingDecision = await decision(missing.service, 'merchant.start')
    expect(missing.listV2EntitlementSnapshots).toHaveBeenCalledOnce()
    expect(missingDecision).toMatchObject({
      allowed: false, error_code: 'COMMERCIAL_ENTITLEMENT_REQUIRED',
    })

    const unavailable = harness({ state: 'known', available_points: 1, access_revision: 'r1', freshness: 'fresh' }, undefined, {}, 'unavailable')
    expect(await decision(unavailable.service, 'merchant.start')).toMatchObject({
      allowed: false, error_code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE',
    })
  })

  it('distinguishes unavailable rate, stale quote, insufficient points, and allowed quote', async () => {
    const unavailable = harness({ state: 'known', available_points: 8, access_revision: 'r3', freshness: 'fresh' }, { state: 'unavailable' })
    expect(await decision(unavailable.service, 'catalog.image.generate')).toMatchObject({
      quoted_points: null, rate_card_version: null, allowed: false, error_code: ERROR_CODES.RATE_CARD_UNAVAILABLE,
    })

    const stale = harness({ state: 'known', available_points: 8, access_revision: 'r3', freshness: 'stale' }, { state: 'approved', quoted_points: 5, rate_card_version: 'rate-v2' })
    expect(await decision(stale.service, 'catalog.image.generate')).toMatchObject({
      quoted_points: 5, rate_card_version: 'rate-v2', allowed: false, error_code: ERROR_CODES.COMMERCIAL_ACCESS_STALE,
    })

    const insufficient = harness({ state: 'known', available_points: 4, access_revision: 'r4', freshness: 'fresh' }, { state: 'approved', quoted_points: 5, rate_card_version: 'rate-v2' })
    expect(await decision(insufficient.service, 'catalog.image.generate')).toMatchObject({
      available_points: 4, quoted_points: 5, allowed: false, error_code: ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT,
    })

    const allowed = harness({ state: 'known', available_points: 5, access_revision: 'r5', freshness: 'fresh' }, { state: 'approved', quoted_points: 5, rate_card_version: 'rate-v2' })
    expect(await decision(allowed.service, 'catalog.image.generate')).toMatchObject({
      available_points: 5, quoted_points: 5, rate_card_version: 'rate-v2', allowed: true, error_code: null,
    })
    expect(allowed.resolveApprovedRate).toHaveBeenCalledWith({
      workspace_id: 'workspace-1', operation: { surface: 'MCP', operation: 'catalog.image.generate' }, rate_action: 'catalog.image.generate',
    })
  })

  it('treats malformed projection and rate adapter values as unavailable', async () => {
    const malformedBalance = harness({ state: 'known', available_points: -1, access_revision: 'r1', freshness: 'fresh' })
    expect(await decision(malformedBalance.service, 'merchant.start')).toMatchObject({
      balance_state: 'unknown', available_points: null, error_code: ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE,
    })

    const malformedRate = harness(
      { state: 'known', available_points: 4, access_revision: 'r1', freshness: 'fresh' },
      { state: 'approved', quoted_points: 0, rate_card_version: 'rate-v1' },
    )
    expect(await decision(malformedRate.service, 'catalog.image.generate')).toMatchObject({
      quoted_points: null, error_code: ERROR_CODES.RATE_CARD_UNAVAILABLE,
    })
  })

  it('rejects malformed service and request identity configuration', async () => {
    expect(() => new CommercialAccessService({
      registry,
      registry_version: ' ',
      balance_projection: { projectCreativePointBalance: async () => ({ state: 'unknown' }) },
      rate_resolver: { resolveApprovedRate: async () => ({ state: 'unavailable' }) },
    })).toThrow('registry_version')

    const h = harness({ state: 'unknown' })
    await expect(h.service.decide({ surface: 'MCP', operation: 'merchant.start', workspace_id: '' })).rejects.toThrow('workspace_id')
    await expect(h.service.decide({ ...request('merchant.start'), required_access_revision: ' ' })).rejects.toThrow('required_access_revision')

    const invalidId = harness({ state: 'unknown' }, undefined, { id_factory: () => ' ' })
    await expect(invalidId.service.decide(request('merchant.start'))).rejects.toThrow('decision_id')
    const invalidTime = harness({ state: 'unknown' }, undefined, { now: () => new Date(Number.NaN) })
    await expect(invalidTime.service.decide(request('merchant.start'))).rejects.toThrow('invalid date')
  })
})
