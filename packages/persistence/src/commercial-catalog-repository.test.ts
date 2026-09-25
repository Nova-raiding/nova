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

  it('appends the complete draft, approval, publish, and retirement lifecycle', async () => {
    const repository = new MemoryCommercialCatalogRepository([], [], () => Date.now() + 1000)
    const draft = await repository.mutate({ action: 'create', code: 'growth', kind: 'monthly', priceFen: 500000, payload: { name: '成长版' }, actorId: 'ops', reason: 'create', evidence: {} })
    const approved = await repository.mutate({ action: 'approve', code: 'growth', actorId: 'ops', reason: 'approve', evidence: {} })
    const published = await repository.mutate({ action: 'publish', code: 'growth', actorId: 'ops', reason: 'publish', evidence: {} })
    const retired = await repository.mutate({ action: 'retire', code: 'growth', actorId: 'ops', reason: 'retire', evidence: {} })
    expect([draft, approved, published, retired].map(item => [item.version, item.lifecycle, item.executable])).toEqual([
      [1, 'draft', false], [2, 'approved', false], [3, 'approved', true], [4, 'retired', false],
    ])
    expect((await repository.resolveApprovedExecutableSku('growth')).version).toBe(3)
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

  it('reads and resolves only the approved OCR cost multiplier snapshot', async () => {
    const row = {
      id: 'rate-ocr-extract-cost-v3', rateCardId: 'rate-card-ocr-cost-v3', version: 3,
      actionCode: 'ocr.extract', unit: 'request', integerPoints: null, pricingMode: 'variable',
      variableFormula: { kind: 'cost_cny_x2_ceil_min1' }, lifecycle: 'approved', approvalStatus: 'approved',
      executable: true, ruleExecutable: true, checksum: 'a'.repeat(64), effectiveAt: '2026-09-25T00:00:00.000Z', blockers: [],
    }
    const client = new FakeClient([row])
    const repository = new PostgresCommercialCatalogRepository(new FakePool(client))
    expect(await repository.listRates()).toEqual([expect.objectContaining({
      actionCode: 'ocr.extract', pricingMode: 'variable', integerPoints: null,
      variableFormula: { kind: 'cost_cny_x2_ceil_min1' },
    })])
    expect(await repository.resolveApprovedOcrCostRate()).toMatchObject({
      actionCode: 'ocr.extract', pricingMode: 'variable', variableFormula: { kind: 'cost_cny_x2_ceil_min1' },
      version: 3, checksum: 'a'.repeat(64),
    })
    expect(client.calls[1]?.text).toContain("r.action_code = 'ocr.extract'")
    expect(client.calls[1]?.text).toContain("r.pricing_mode = 'variable'")
  })

  it('rejects an altered OCR formula even when the rate card claims approved', async () => {
    const client = new FakeClient([{
      rateCardId: 'rate-card-ocr-cost-v3', version: 3, actionCode: 'ocr.extract', unit: 'request',
      pricingMode: 'variable', variableFormula: { kind: 'cost_cny_x3_ceil_min1' },
      checksum: 'a'.repeat(64), effectiveAt: '2026-09-25T00:00:00.000Z',
    }])
    const repository = new PostgresCommercialCatalogRepository(new FakePool(client))
    await expect(repository.resolveApprovedOcrCostRate()).rejects.toMatchObject({ code: 'RATE_CARD_UNAVAILABLE' })
  })
})
