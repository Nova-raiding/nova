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
    const draft = await repository.mutate({ action: 'create', code: 'growth', kind: 'monthly', priceFen: 500000, payload: { name: '成长版', blockers: [], planFamily:'standard',tierRank:2,cycle:{unit:'month',count:1}, purchasePolicy:{version:'test-v3',expiresInSeconds:3600,approved:true} }, benefits: [{code:'monthly_creative_points',quantity:12500,rawValue:null,rawUnit:'point',normalizedValue:12500,policyRef:'commercial.plan.growth.v2',metadata:{}}], expectedRevision:0,idempotencyKey:'draft', actorId: 'ops', reason: 'create', evidence: {} })
    const approved = await repository.mutate({ action: 'approve', code: 'growth', expectedRevision:1,idempotencyKey:'approve', actorId: 'ops', reason: 'approve', evidence: {} })
    const published = await repository.mutate({ action: 'publish', code: 'growth', expectedRevision:2,idempotencyKey:'publish', actorId: 'ops', reason: 'publish', evidence: {} })
    const retired = await repository.mutate({ action: 'retire', code: 'growth', expectedRevision:3,idempotencyKey:'retire', actorId: 'ops', reason: 'retire', evidence: {} })
    expect([draft, approved, published, retired].map(item => [item.version, item.lifecycle, item.executable])).toEqual([
      [1, 'draft', false], [2, 'approved', false], [3, 'approved', true], [4, 'retired', false],
    ])
    await expect(repository.resolveApprovedExecutableSku('growth')).rejects.toBeInstanceOf(CommercialCatalogUnavailableError)
    expect(retired.saleState).toBe('off_sale')
  })

  it('preserves the current sale while editing and rejects stale writes and changed idempotent requests', async () => {
    const live = snapshot({lifecycle:'approved',executable:true,effectiveAt:'2026-01-01T00:00:00Z'})
    const repository = new MemoryCommercialCatalogRepository([live])
    const request = { action:'create' as const,code:'basic',priceFen:250000,expectedRevision:0,idempotencyKey:'edit',actorId:'ops',reason:'reprice',evidence:{} }
    const draft = await repository.mutate(request)
    expect(draft.saleState).toBe('on_sale')
    expect((await repository.resolveApprovedExecutableSku('basic')).priceFen).toBe(200000)
    expect(await repository.mutate(request)).toEqual(draft)
    await expect(repository.mutate({...request,priceFen:260000})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_CONFLICT'})
    await expect(repository.mutate({...request,idempotencyKey:'stale'})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_CONFLICT'})
  })

  it('requires approval and resolved consumers to publish, and protects identity', async () => {
    const repository = new MemoryCommercialCatalogRepository([snapshot()])
    await expect(repository.mutate({action:'publish',code:'basic',expectedRevision:0,idempotencyKey:'bad-pub',actorId:'ops',reason:'publish',evidence:{}})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_CONFLICT'})
    await expect(repository.mutate({action:'create',code:'basic',kind:'point_pack',expectedRevision:0,idempotencyKey:'identity',actorId:'ops',reason:'change',evidence:{}})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_CONFLICT'})
    const approved = await repository.mutate({action:'approve',code:'basic',expectedRevision:0,idempotencyKey:'approve',actorId:'ops',reason:'approve',evidence:{}})
    await expect(repository.mutate({action:'publish',code:'basic',versionId:approved.versionId,expectedRevision:1,idempotencyKey:'unresolved',actorId:'ops',reason:'publish',evidence:{}})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_UNAVAILABLE'})
  })

  it('does not restore ambiguous history or historical approved versions after retirement', async () => {
    const approved = snapshot({lifecycle:'approved',executable:true,effectiveAt:'2026-01-01T00:00:00Z'})
    for (const versions of [[approved,{...approved,version:2,versionId:'v2'}],[approved,{...approved,version:2,versionId:'v2',lifecycle:'retired' as const,executable:false}]]) {
      await expect(new MemoryCommercialCatalogRepository(versions).resolveApprovedExecutableSku('basic')).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_UNAVAILABLE'})
    }
  })

  it('records rejection explicitly and does not publish without an approved expiry policy', async () => {
    const repository = new MemoryCommercialCatalogRepository([snapshot({payload:{blockers:[]}})])
    const request = {code:'basic',actorId:'ops',reason:'review',evidence:{}}
    const rejected=await repository.mutate({...request,action:'reject',expectedRevision:0,idempotencyKey:'reject'})
    expect(rejected.lifecycle).toBe('rejected')
    await expect(repository.mutate({...request,action:'approve',expectedRevision:1,idempotencyKey:'approve-rejected'})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_CONFLICT'})
    const draft=await repository.mutate({...request,action:'create',expectedRevision:1,idempotencyKey:'edit',benefits:[{code:'monthly_creative_points',quantity:5000,rawValue:null,rawUnit:'point',normalizedValue:5000,policyRef:'test-v3',metadata:{}}]})
    await repository.mutate({...request,action:'approve',expectedRevision:2,idempotencyKey:'approve'})
    await expect(repository.mutate({...request,action:'publish',expectedRevision:3,idempotencyKey:'pub-no-policy'})).rejects.toThrow('expiry policy')
    expect(draft.saleState).toBe('unlisted')
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

  it.each([
    { name: 'empty approval reference', patch: {purchasePolicy:{approved:true,version:' ',expiresInSeconds:3600}} },
    { name: 'unconsumable payment window', patch: {purchasePolicy:{approved:true,version:'approved-v1',expiresInSeconds:604801}} },
    { name: 'missing family', patch: {planFamily:undefined} },
    { name: 'missing rank', patch: {tierRank:undefined} },
    { name: 'nonintegral rank', patch: {tierRank:1.5} },
    { name: 'missing explicit cycle', patch: {cycle:undefined} },
    { name: 'unsupported cycle consumer', patch: {cycle:{unit:'day',count:30},pointGrantPolicy:{cadence:'monthly'}} },
  ])('does not put approved but unconsumable monthly terms on sale: $name', async ({patch}) => {
    const repository = new MemoryCommercialCatalogRepository([])
    const request={code:'owned-policy',actorId:'ops',reason:'verify executable terms',evidence:{}}
    await repository.mutate({...request,action:'create',kind:'monthly',priceFen:200000,payload:{blockers:[],planFamily:'standard',tierRank:1,cycle:{unit:'month',count:1},purchasePolicy:{approved:true,version:'approved-v1',expiresInSeconds:3600},...patch},benefits:[{code:'monthly_creative_points',quantity:100,rawValue:null,rawUnit:'point',normalizedValue:100,policyRef:'owned-points',metadata:{}}],expectedRevision:0,idempotencyKey:'create'})
    await repository.mutate({...request,action:'approve',expectedRevision:1,idempotencyKey:'approve'})
    await expect(repository.mutate({...request,action:'publish',expectedRevision:2,idempotencyKey:'publish'})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_UNAVAILABLE'})
    expect((await repository.get('owned-policy'))?.saleState).toBe('unlisted')
    await expect(repository.resolveApprovedExecutableSku('owned-policy')).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_UNAVAILABLE'})
  })

  it('publishes only V3-supported period and point-grant combinations', async () => {
    const valid = [
      { cycle: { unit: 'month', count: 1 }, cadence: 'once' },
      { cycle: { unit: 'month', count: 1 }, cadence: 'monthly' },
      { cycle: { unit: 'month', count: 3 }, cadence: 'once' },
      { cycle: { unit: 'month', count: 3 }, cadence: 'monthly' },
      { cycle: { unit: 'month', count: 6 }, cadence: 'once' },
      { cycle: { unit: 'month', count: 6 }, cadence: 'monthly' },
      { cycle: { unit: 'month', count: 12 }, cadence: 'once' },
      { cycle: { unit: 'month', count: 12 }, cadence: 'monthly' },
      { cycle: { unit: 'day', count: 30 }, cadence: 'once' },
    ] as const
    for (const [index, terms] of valid.entries()) {
      const code = `supported-cycle-${index}`
      const repository = new MemoryCommercialCatalogRepository([])
      const request = { code, actorId: 'ops', reason: 'verify period consumer', evidence: {} }
      await repository.mutate({ ...request, action: 'create', kind: 'monthly', priceFen: 200000, payload: { blockers: [], planFamily: 'standard', tierRank: 1, purchasePolicy: { approved: true, version: 'owned-cycle-v1', expiresInSeconds: 3600 }, cycle: terms.cycle, pointGrantPolicy: { cadence: terms.cadence } }, benefits: [{ code: 'monthly_creative_points', quantity: 100, rawValue: null, rawUnit: 'point', normalizedValue: 100, policyRef: 'owned-cycle-v1', metadata: {} }], expectedRevision: 0, idempotencyKey: `${code}-create` })
      await repository.mutate({ ...request, action: 'approve', expectedRevision: 1, idempotencyKey: `${code}-approve` })
      await expect(repository.mutate({ ...request, action: 'publish', expectedRevision: 2, idempotencyKey: `${code}-publish` })).resolves.toMatchObject({ saleState: 'on_sale' })
    }

    const invalid = [
      { name: 'month two', cycle: { unit: 'month', count: 2 }, cadence: 'once' },
      { name: 'day monthly', cycle: { unit: 'day', count: 30 }, cadence: 'monthly' },
      { name: 'multi-cycle cadence missing', cycle: { unit: 'month', count: 3 }, cadence: undefined },
    ] as const
    for (const [index, terms] of invalid.entries()) {
      const code = `unsupported-cycle-${index}`
      const repository = new MemoryCommercialCatalogRepository([])
      const request = { code, actorId: 'ops', reason: 'reject unsupported period', evidence: {} }
      const payload = { blockers: [], planFamily: 'standard', tierRank: 1, purchasePolicy: { approved: true, version: 'owned-cycle-v1', expiresInSeconds: 3600 }, cycle: terms.cycle, ...(terms.cadence ? { pointGrantPolicy: { cadence: terms.cadence } } : {}) }
      await repository.mutate({ ...request, action: 'create', kind: 'monthly', priceFen: 200000, payload, benefits: [{ code: 'monthly_creative_points', quantity: 100, rawValue: null, rawUnit: 'point', normalizedValue: 100, policyRef: 'owned-cycle-v1', metadata: {} }], expectedRevision: 0, idempotencyKey: `${code}-create` })
      await repository.mutate({ ...request, action: 'approve', expectedRevision: 1, idempotencyKey: `${code}-approve` })
      await expect(repository.mutate({ ...request, action: 'publish', expectedRevision: 2, idempotencyKey: `${code}-publish` })).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_UNAVAILABLE' })
      expect((await repository.get(code))?.saleState).toBe('unlisted')
    }
  })

  it('independently approves and publishes all three configured standard tiers', async () => {
    const repository = new MemoryCommercialCatalogRepository([])
    for (const [code,tierRank,priceFen] of [['basic',1,200000],['growth',2,500000],['premium',3,1000000]] as const) {
      const request={code,actorId:'ops',reason:'independent business approval',evidence:{approvedReference:`owned-${code}`}}
      await repository.mutate({...request,action:'create',kind:'monthly',priceFen,payload:{blockers:[],planFamily:'standard',tierRank,cycle:{unit:'month',count:1},purchasePolicy:{approved:true,version:`owned-${code}`,expiresInSeconds:604800}},benefits:[{code:'monthly_creative_points',quantity:tierRank*100,rawValue:null,rawUnit:'point',normalizedValue:tierRank*100,policyRef:`owned-${code}`,metadata:{}}],expectedRevision:0,idempotencyKey:`${code}-create`})
      await repository.mutate({...request,action:'approve',expectedRevision:1,idempotencyKey:`${code}-approve`})
      await repository.mutate({...request,action:'publish',expectedRevision:2,idempotencyKey:`${code}-publish`})
      expect(await repository.resolveApprovedExecutableSku(code)).toMatchObject({code,priceFen,payload:{planFamily:'standard',tierRank,cycle:{unit:'month',count:1}}})
    }
  })

  it('publishes explicitly approved onboarding schedules with frozen 500 or 600 points and rejects unresolved policy', async () => {
    for (const points of [500, 600]) {
      const policyRef = {policyId:'commercial.onboarding',version:'v2'}
      const payload = {blockers:[],policyRef,purchasePolicy:{version:'test-v3',approved:true,expiresInSeconds:3600},grantSchedule:{policyRef,grantCount:6,pointsPerGrant:points,cadence:'monthly',timezone:'UTC',startsAt:'payment_verified',grantExpiresAtRule:'next_monthly_anniversary',schedulingStatus:'resolved'}}
      const repository = new MemoryCommercialCatalogRepository([], [], () => Date.now() + 1000)
      const request = {code:`onboarding_${points}`,actorId:'ops',reason:'approved configured gift',evidence:{}}
      await repository.mutate({...request,action:'create',kind:'onboarding',priceFen:500000,payload,benefits:[],expectedRevision:0,idempotencyKey:'create'})
      await repository.mutate({...request,action:'approve',expectedRevision:1,idempotencyKey:'approve'})
      const published = await repository.mutate({...request,action:'publish',expectedRevision:2,idempotencyKey:'publish'})
      expect(published.payload.grantSchedule).toMatchObject({grantCount:6,pointsPerGrant:points})
    }
    const repository = new MemoryCommercialCatalogRepository([snapshot({kind:'onboarding',benefits:[],payload:{blockers:[],purchasePolicy:{version:'test-v3',approved:true,expiresInSeconds:3600},grantSchedule:{grantCount:6,pointsPerGrant:500}}})])
    await repository.mutate({action:'approve',code:'basic',actorId:'ops',reason:'review',evidence:{},expectedRevision:0,idempotencyKey:'approve'})
    await expect(repository.mutate({action:'publish',code:'basic',actorId:'ops',reason:'publish',evidence:{},expectedRevision:1,idempotencyKey:'publish'})).rejects.toThrow('registered onboarding')
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
      executable: true, ruleExecutable: true, checksum: 'a'.repeat(64), effectiveAt: '2026-09-25T00:00:00.000Z', blockers: [], purchasePolicy:{version:'test-v3',expiresInSeconds:3600,approved:true},
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
    expect(client.calls[1]?.text).toContain('r.pricing_mode AS "pricingMode"')
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

  it('resolves the exact v4 OCR free threshold without falling back to v3', async () => {
    const formula = { kind: 'cost_cny_threshold_x2_ceil_v1', free_when_cost_cny_lte: 0.3, multiplier: 2, min_paid_points: 1 }
    const row = {
      id: 'rate-ocr-extract-cost-v4', rateCardId: 'rate-card-ocr-cost-v4', version: 4,
      actionCode: 'ocr.extract', unit: 'request', integerPoints: null, pricingMode: 'variable',
      variableFormula: formula, lifecycle: 'approved', approvalStatus: 'approved',
      executable: true, ruleExecutable: true, checksum: 'b'.repeat(64), effectiveAt: '2026-09-25T01:00:00.000Z', blockers: [], purchasePolicy:{version:'test-v3',expiresInSeconds:3600,approved:true},
    }
    const client = new FakeClient([row])
    const repository = new PostgresCommercialCatalogRepository(new FakePool(client))
    expect(await repository.listRates()).toEqual([expect.objectContaining({ variableFormula: formula })])
    expect(await repository.resolveApprovedOcrCostRate()).toMatchObject({ version: 4, variableFormula: formula })
    expect(client.calls[1]?.text).toContain('ORDER BY c.effective_at DESC, c.version DESC')
    expect(client.calls[1]?.text).not.toContain("r.pricing_mode = 'variable'")
  })

  it('blocks a changed v4 threshold and a newer unsupported OCR rule', async () => {
    const base = {
      rateCardId: 'rate-card-ocr-cost-v4', version: 4, actionCode: 'ocr.extract', unit: 'request',
      integerPoints: null, pricingMode: 'variable', ruleExecutable: true,
      checksum: 'b'.repeat(64), effectiveAt: '2026-09-25T01:00:00.000Z',
    }
    for (const override of [
      { variableFormula: { kind: 'cost_cny_threshold_x2_ceil_v1', free_when_cost_cny_lte: 0.31, multiplier: 2, min_paid_points: 1 } },
      { variableFormula: { kind: 'unsupported_future_formula' } },
      { pricingMode: 'fixed', integerPoints: 1, variableFormula: null },
    ]) {
      const client = new FakeClient([{ ...base, ...override }])
      const repository = new PostgresCommercialCatalogRepository(new FakePool(client))
      await expect(repository.resolveApprovedOcrCostRate()).rejects.toMatchObject({ code: 'RATE_CARD_UNAVAILABLE' })
    }
  })
})
