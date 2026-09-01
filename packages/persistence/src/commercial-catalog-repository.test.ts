import { describe, expect, it } from 'vitest'
import {
  CommercialCatalogUnavailableError,
  CreativePointRateUnavailableError,
  MemoryCommercialCatalogRepository,
  PostgresCommercialCatalogRepository,
  PRIVATE_COMMERCIAL_SKU_READ_CAPABILITY,
  type CommercialCatalogSkuSnapshot,
} from './commercial-catalog-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

function snapshot(overrides: Partial<CommercialCatalogSkuSnapshot> = {}): CommercialCatalogSkuSnapshot {
  return {
    id: 'sku-basic', code: 'basic', kind: 'monthly', visibility: 'public', requiredCapability: null,
    versionId: 'sku-basic-v1', version: 1, lifecycle: 'draft', executable: false,
    priceFen: 200000, currency: 'CNY', priceMode: 'fixed', durationDays: null,
    payload: { storage: { sourceLabel: '50g', normalizedBytes: null } }, checksum: 'checksum',
    effectiveAt: null,
    benefits: [{ code: 'cloud_storage', quantity: 50, rawValue: '50g', rawUnit: 'g', normalizedValue: null, policyRef: 'STORAGE_UNIT_UNRESOLVED', metadata: {} }],
    ...overrides,
  }
}

describe('MemoryCommercialCatalogRepository', () => {
  it('keeps private offers hidden unless both inclusion and capability are present', async () => {
    const privateOffer = snapshot({ id: 'private', code: 'private_validation_7d', kind: 'private_trial', visibility: 'private', requiredCapability: PRIVATE_COMMERCIAL_SKU_READ_CAPABILITY })
    const repository = new MemoryCommercialCatalogRepository([snapshot(), privateOffer])

    expect((await repository.list()).map(item => item.code)).toEqual(['basic'])
    expect((await repository.list({ includePrivate: true })).map(item => item.code)).toEqual(['basic'])
    expect(await repository.get('private_validation_7d', { capabilities: [PRIVATE_COMMERCIAL_SKU_READ_CAPABILITY] })).toBeUndefined()
    expect((await repository.list({ includePrivate: true, capabilities: [PRIVATE_COMMERCIAL_SKU_READ_CAPABILITY] })).map(item => item.code)).toEqual(['basic', 'private_validation_7d'])
  })

  it('does not resolve draft catalog entries as executable', async () => {
    const repository = new MemoryCommercialCatalogRepository([snapshot()])
    await expect(repository.resolveApprovedExecutableSku('basic')).rejects.toBeInstanceOf(CommercialCatalogUnavailableError)
  })

  it('fails closed for source draft image rates even when their numeric value is 1', async () => {
    const repository = new MemoryCommercialCatalogRepository([], [{
      rateCardId: 'draft-v1', version: 1, actionCode: 'image.generate.standard', unit: 'image',
      integerPoints: 1, checksum: 'draft', effectiveAt: '2026-09-01T00:00:00.000Z',
      lifecycle: 'pending_business_approval', executable: false,
    }])
    expect(await repository.listRates()).toMatchObject([{ actionCode: 'image.generate.standard', lifecycle: 'pending_business_approval', executable: false }])
    await expect(repository.resolveApprovedRate('image.generate.standard')).rejects.toBeInstanceOf(CreativePointRateUnavailableError)
  })

  it('rejects ambiguous approved rates instead of choosing one', async () => {
    const approved = { rateCardId: 'approved-v1', version: 1, actionCode: 'image.generate.standard', unit: 'image' as const, integerPoints: 1, checksum: 'approved', effectiveAt: '2026-09-01T00:00:00.000Z' }
    const repository = new MemoryCommercialCatalogRepository([], [approved, { ...approved, rateCardId: 'approved-v2', version: 2 }])
    await expect(repository.resolveApprovedRate('image.generate.standard')).rejects.toMatchObject({ code: 'RATE_CARD_UNAVAILABLE' })
  })
})

class FakeClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  constructor(private readonly rows: unknown[]) {}
  async query<Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return { rows: this.rows as Row[] }
  }
  release() {}
}

class FakePool implements SqlPool {
  constructor(readonly client: FakeClient) {}
  async connect() { return this.client }
}

describe('PostgresCommercialCatalogRepository', () => {
  it('passes private visibility as a database filter, not a post-query disclosure', async () => {
    const client = new FakeClient([])
    const repository = new PostgresCommercialCatalogRepository(new FakePool(client))
    await repository.list({ includePrivate: true, capabilities: [PRIVATE_COMMERCIAL_SKU_READ_CAPABILITY] })
    expect(client.calls[0]?.text).toContain("s.visibility = 'public'")
    expect(client.calls[0]?.text).toContain('s.required_capability = ANY')
    expect(client.calls[0]?.values).toEqual([true, [PRIVATE_COMMERCIAL_SKU_READ_CAPABILITY]])
  })

  it('requires approved executable fixed rates and rejects no rows', async () => {
    const client = new FakeClient([])
    const repository = new PostgresCommercialCatalogRepository(new FakePool(client))
    await expect(repository.resolveApprovedRate('image.generate.standard')).rejects.toMatchObject({ code: 'RATE_CARD_UNAVAILABLE' })
    expect(client.calls[0]?.text).toContain("c.lifecycle = 'approved'")
    expect(client.calls[0]?.text).toContain("c.approval_status = 'approved'")
    expect(client.calls[0]?.text).toContain("r.pricing_mode = 'fixed'")
    expect(client.calls[0]?.text).toContain('LIMIT 2')
  })

  it('lists draft rate facts without treating them as approved execution rates', async () => {
    const client = new FakeClient([{
      id: 'rate-image', rateCardId: 'draft-v1', version: 1, actionCode: 'image.generate.standard', unit: 'image',
      integerPoints: '1', pricingMode: 'fixed', lifecycle: 'pending_business_approval', approvalStatus: 'pending_business_approval',
      executable: false, ruleExecutable: false, checksum: 'checksum', effectiveAt: null, blockers: ['BUSINESS_APPROVAL_REQUIRED'],
    }])
    const repository = new PostgresCommercialCatalogRepository(new FakePool(client))
    expect(await repository.listRates()).toEqual([expect.objectContaining({ id: 'rate-image', integerPoints: 1, effectiveAt: null, blockers: ['BUSINESS_APPROVAL_REQUIRED'] })])
    expect(client.calls[0]?.text).not.toContain("c.lifecycle = 'approved'")
  })

  it('maps unsafe approved point values to RATE_CARD_UNAVAILABLE', async () => {
    const client = new FakeClient([{
      rateCardId: 'approved-v1', version: 1, actionCode: 'image.generate.standard', unit: 'image',
      integerPoints: '9007199254740992', checksum: 'checksum', effectiveAt: '2026-09-01T00:00:00.000Z',
    }])
    const repository = new PostgresCommercialCatalogRepository(new FakePool(client))
    await expect(repository.resolveApprovedRate('image.generate.standard')).rejects.toMatchObject({ code: 'RATE_CARD_UNAVAILABLE' })
  })
})
