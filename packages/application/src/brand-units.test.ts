import { describe, expect, it } from 'vitest'
import { BrandUnitError, BrandUnitService } from './brand-units.js'

const setup = () => {
  const service = new BrandUnitService()
  const a = service.createBrandUnit({ workspaceId: 'ws_1', name: '户外品' })
  const b = service.createBrandUnit({ workspaceId: 'ws_1', name: '家居品' })
  const store = service.registerPlatformAccount({ workspaceId: 'ws_1', platform: 'taobao', remoteAccountId: 'tb-1', label: '淘宝旗舰店' })
  return { service, a, b, store }
}

describe('BrandUnitService', () => {
  it('creates, lists and updates brand units with workspace and revision guards', () => {
    const { service, a } = setup()
    expect(service.listBrandUnits('ws_1')).toHaveLength(2)
    expect(service.updateBrandUnit({ workspaceId: 'ws_1', brandId: a.id, name: '户外生活', expectedRevision: 1 })).toMatchObject({ name: '户外生活', revision: 2 })
    expect(() => service.updateBrandUnit({ workspaceId: 'ws_2', brandId: a.id })).toThrowError(expect.objectContaining({ code: 'BRAND_UNIT_NOT_FOUND' }))
    expect(() => service.updateBrandUnit({ workspaceId: 'ws_1', brandId: a.id, expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'BRAND_UNIT_VERSION_CONFLICT' }))
  })

  it('allows one store to bind multiple brands, but rejects cross-workspace binding', () => {
    const { service, a, b, store } = setup()
    expect(service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })).toMatchObject({ brandId: a.id })
    expect(service.bindStore({ workspaceId: 'ws_1', brandId: b.id, accountId: store.id })).toMatchObject({ brandId: b.id })
    expect(service.listStoreBindings('ws_1', a.id)).toHaveLength(1)
    expect(() => service.bindStore({ workspaceId: 'ws_2', brandId: a.id, accountId: store.id })).toThrowError(expect.objectContaining({ code: 'BRAND_UNIT_NOT_FOUND' }))
  })

  it('requires explicit brand scope for products and listings', () => {
    const { service, a, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, title: '轻量外套' })
    const listing = service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id, remoteProductId: 'tb-p1' })
    expect(listing).toMatchObject({ brandId: a.id, accountId: store.id })
    expect(() => service.createListing({ workspaceId: 'ws_1', brandId: 'brand_other', canonicalProductId: product.id, platform: 'taobao', accountId: store.id })).toThrowError(expect.objectContaining({ code: 'BRAND_ID_MISMATCH' }))
    expect(() => service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'jd', accountId: store.id })).toThrowError(expect.objectContaining({ code: 'PLATFORM_MISMATCH' }))
  })

  it('fails closed instead of overwriting canonical products or duplicate store listings', () => {
    const { service, a, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, id: 'canonical-1', title: '外套' })
    expect(() => service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, id: product.id, title: '被覆盖的外套' })).toThrowError(expect.objectContaining({ code: 'CANONICAL_PRODUCT_CONFLICT' }))
    service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id, id: 'listing-1' })
    expect(() => service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id, id: 'listing-2' })).toThrowError(expect.objectContaining({ code: 'LISTING_TARGET_CONFLICT' }))
    expect(() => service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id, id: 'listing-1' })).toThrowError(expect.objectContaining({ code: 'LISTING_CONFLICT' }))
  })

  it('returns workspace-scoped canonical detail and fail-closed publish status', () => {
    const { service, a, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, id: 'canonical-detail-1', title: '详情外套' })
    const draft = service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id, id: 'listing-detail-1' })

    expect(service.getCanonicalProductDetail('ws_1', product.id)).toMatchObject({
      product: { id: product.id, workspaceId: 'ws_1' },
      brand: { id: a.id, workspaceId: 'ws_1' },
      listings: [{ id: draft.id, workspaceId: 'ws_1', state: 'draft' }],
      publishGate: { status: 'blocked', blockers: ['CANONICAL_LISTING_NOT_ACTIVE'] },
    })
    expect(() => service.getCanonicalProductDetail('ws_other', product.id)).toThrowError(expect.objectContaining({ code: 'PRODUCT_NOT_FOUND' }))

    service.listings.set(draft.id, { ...draft, state: 'active' })
    expect(service.getCanonicalProductDetail('ws_1', product.id).publishGate).toEqual({ status: 'verified', blockers: [] })
  })

  it('preflights up to 50 items, aggregates blocked scope and is idempotent', () => {
    const { service, a, b, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, title: '外套' })
    const listing = service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id })
    const input = { workspaceId: 'ws_1', idempotencyKey: 'campaign-1', items: [{ brandId: a.id, canonicalProductId: product.id, listingId: listing.id, platform: 'taobao' as const, accountId: store.id }, { brandId: b.id, canonicalProductId: product.id, listingId: listing.id, platform: 'taobao' as const, accountId: store.id }] }
    const first = service.preflightCampaign(input)
    expect(first.aggregate).toEqual({ total: 2, ready: 0, blocked: 2, state: 'blocked' })
    expect(first.items[0]?.blockers).toEqual(['LISTING_NOT_ACTIVE'])
    expect(first.items[1]?.blockers).toContain('BRAND_ID_MISMATCH')
    expect(service.preflightCampaign(input)).toEqual(first)
    expect(() => service.preflightCampaign({ ...input, idempotencyKey: 'campaign-1', items: [input.items[0]!] })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED' }))
    expect(() => service.preflightCampaign({ workspaceId: 'ws_1', idempotencyKey: 'too-many', items: Array.from({ length: 51 }, () => input.items[0]!) })).toThrowError(expect.objectContaining({ code: 'CAMPAIGN_LIMIT_EXCEEDED' }))
  })

  it('preflights a task and publish target without allowing workspace identity to leak', () => {
    const { service, a, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, id: 'canonical-task-1', title: '外套' })
    const listing = service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id, id: 'listing-task-1', state: 'active' })
    const target = { taskId: 'task-1', workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, listingId: listing.id, platform: 'taobao' as const, accountId: store.id }

    expect(service.preflightTaskTarget(target)).toEqual({ ...target, state: 'ready', blockers: [] })
    expect(service.preflightTaskTarget({ ...target, workspaceId: 'ws_2' })).toMatchObject({ state: 'blocked', blockers: ['BRAND_UNIT_NOT_FOUND'] })
    expect(service.preflightTaskTarget({ ...target, taskId: 'task-2', listingId: 'listing-from-another-workspace' })).toMatchObject({ state: 'blocked', blockers: ['LISTING_NOT_FOUND'] })
  })

  it('reports every target scope mismatch instead of treating a foreign listing as publishable', () => {
    const { service, a, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, title: '外套' })
    const listing = service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id })
    const result = service.preflightTaskTarget({ taskId: 'task-1', workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, listingId: listing.id, platform: 'jd', accountId: store.id })
    expect(result).toMatchObject({ state: 'blocked', blockers: expect.arrayContaining(['PLATFORM_MISMATCH']) })
    expect(result.blockers).toContain('LISTING_TARGET_MISMATCH')
  })

  it('blocks draft listings at the task and publish preflight boundary', () => {
    const { service, a, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, title: '外套' })
    const listing = service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id })
    const target = { taskId: 'task-draft-listing', workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, listingId: listing.id, platform: 'taobao' as const, accountId: store.id }

    expect(service.preflightTaskTarget(target)).toMatchObject({ state: 'blocked', blockers: ['LISTING_NOT_ACTIVE'] })

    service.listings.set(listing.id, { ...listing, state: 'active' })
    expect(service.preflightTaskTarget(target)).toMatchObject({ state: 'ready', blockers: [] })
  })

  it('blocks draft listings at the campaign preflight boundary', () => {
    const { service, a, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, title: '待激活外套' })
    const listing = service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id, state: 'draft' })

    const result = service.preflightCampaign({
      workspaceId: 'ws_1',
      idempotencyKey: 'draft-listing-campaign',
      items: [{ brandId: a.id, canonicalProductId: product.id, listingId: listing.id, platform: 'taobao', accountId: store.id }],
    })

    expect(result).toMatchObject({ aggregate: { total: 1, ready: 0, blocked: 1, state: 'blocked' }, items: [{ state: 'blocked', blockers: ['LISTING_NOT_ACTIVE'] }] })
  })

  it('blocks archived canonical products at both campaign and task preflight boundaries', () => {
    const { service, a, store } = setup()
    service.bindStore({ workspaceId: 'ws_1', brandId: a.id, accountId: store.id })
    const product = service.createCanonicalProduct({ workspaceId: 'ws_1', brandId: a.id, title: '归档商品', state: 'archived' })
    const listing = service.createListing({ workspaceId: 'ws_1', brandId: a.id, canonicalProductId: product.id, platform: 'taobao', accountId: store.id, state: 'active' })
    const item = { brandId: a.id, canonicalProductId: product.id, listingId: listing.id, platform: 'taobao' as const, accountId: store.id }

    expect(service.preflightCampaign({ workspaceId: 'ws_1', idempotencyKey: 'archived-product', items: [item] }).items[0]).toMatchObject({ state: 'blocked', blockers: ['CANONICAL_PRODUCT_NOT_ACTIVE'] })
    expect(service.preflightTaskTarget({ ...item, taskId: 'task-archived-product', workspaceId: 'ws_1' })).toMatchObject({ state: 'blocked', blockers: ['CANONICAL_PRODUCT_NOT_ACTIVE'] })
  })

  it('rejects invalid input with a stable domain error', () => {
    expect(() => new BrandUnitService().createBrandUnit({ workspaceId: 'ws_1', name: ' ' })).toThrowError(new BrandUnitError('INVALID_INPUT', 'name is required'))
  })
})
