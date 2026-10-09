import { describe, expect, it } from 'vitest'
import { merchantRiskDestination, merchantRouteFromLocation, urlForMerchantRoute } from './navigation.js'

describe('transaction risk navigation boundaries', () => {
  it.each(['content_version', 'publish_job'])('uses the owning task, never the %s entity ID, for review', (entityType) => {
    const destination = merchantRiskDestination({
      type: 'CONTENT_BLOCKING', entityType, entityId: 'version-or-job-id',
      evidence: { taskId: '  task-42  ' },
    })
    expect(destination).toEqual({ page: 'task', target: { kind: 'task', taskId: 'task-42' } })
  })

  it.each(['content_version', 'publish_job'])('does not invent a task from %s when task evidence is absent', (entityType) => {
    for (const evidence of [undefined, {}, { taskId: '' }, { taskId: ' \t ' }]) {
      const destination = merchantRiskDestination({
        type: 'CONTENT_BLOCKING', entityType, entityId: 'not-a-task-id', evidence,
      })
      expect(destination).toEqual({ page: 'overview' })
      expect(urlForMerchantRoute({ pathname: '/merchant/overview', search: '?section=knowledge&image_job=old' }, destination))
        .toBe('/merchant/overview')
    }
  })

  it.each([undefined, 'future_entity', 'task'])('keeps unsupported entity %s at overview even if it carries task-like metadata', (entityType) => {
    expect(merchantRiskDestination({
      type: 'FUTURE_RISK', entityType, entityId: 'task-looking-id',
      evidence: { taskId: 'do-not-follow' },
    })).toEqual({ page: 'overview' })
  })

  it('does not follow non-string task evidence from an incompatible response', () => {
    for (const taskId of [null, 42, {}, ['task-42']]) {
      // Runtime JSON can come from an older or incompatible API despite the
      // current TypeScript contract; none of these values identifies a task.
      const issue = { type: 'PUBLISH_UNKNOWN', entityType: 'publish_job', evidence: { taskId } }
      expect(merchantRiskDestination(issue as unknown as Parameters<typeof merchantRiskDestination>[0]))
        .toEqual({ page: 'overview' })
    }
  })

  it('opens a manual account authorization issue at its status entry without inventing a task', () => {
    const destination = merchantRiskDestination({ type: 'AUTH_RECONNECT', entityType: 'platform_account', entityId: 'store-or-job', evidence: { taskId: 'irrelevant' } })
    expect(destination).toEqual({ page: 'products', entry: 'products', catalogContext: { intent: 'authorization' } })
    expect(urlForMerchantRoute({ pathname: '/merchant/overview', search: '?q=old&section=knowledge' }, destination))
      .toBe('/merchant/products?section=products&intent=authorization')
  })

  it('opens sync-job issues in the catalog without fabricating a selected task', () => {
    const destination = merchantRiskDestination({ type: 'SYNC_FAILED', entityType: 'sync_job', entityId: 'store-or-job', evidence: { taskId: 'irrelevant' } })
    expect(destination).toEqual({ page: 'products', entry: 'products' })
    expect(urlForMerchantRoute({ pathname: '/merchant/overview', search: '?q=old&section=knowledge' }, destination))
      .toBe('/merchant/products?section=products')
  })

  it('encodes task identity as one path segment and restores it without navigation injection', () => {
    const taskId = '任务/42?section=knowledge#fragment'
    const destination = merchantRiskDestination({ type: 'PUBLISH_UNKNOWN', entityType: 'publish_job', evidence: { taskId } })
    const href = urlForMerchantRoute({ pathname: '/merchant/overview', search: '?q=old&section=knowledge' }, destination)
    const parsed = new URL(href, 'https://example.test')
    expect(parsed.pathname).toBe(`/merchant/tasks/${encodeURIComponent(taskId)}`)
    expect(parsed.search).toBe('')
    expect(parsed.hash).toBe('')
    expect(merchantRouteFromLocation(parsed).target).toEqual({ kind: 'task', taskId })
  })

  it('treats a product title as search text, not an owning task or a route parameter', () => {
    const title = '商品 & section=knowledge / #42'
    const destination = merchantRiskDestination({ type: 'LOW_STOCK', entityType: 'product', entityId: 'product-id', title: ` ${title} ` })
    expect(destination).toEqual({ page: 'products', entry: 'products', searchQuery: title, catalogContext: { productId: 'product-id' } })
    const parsed = new URL(urlForMerchantRoute({ pathname: '/merchant/overview', search: '' }, destination), 'https://example.test')
    expect(parsed.pathname).toBe('/merchant/products')
    expect(parsed.searchParams.get('section')).toBe('products')
    expect(parsed.searchParams.get('q')).toBe(title)
    expect(parsed.searchParams.get('product_id')).toBe('product-id')
    expect(parsed.hash).toBe('')
    expect(merchantRouteFromLocation(parsed)).toEqual({ page: 'products', entry: 'products', searchQuery: title, catalogContext: { productId: 'product-id' } })
  })

  it('preserves product identity and store context when opening a product risk', () => {
    const destination = merchantRiskDestination({
      type: 'LOW_STOCK', entityType: 'product', entityId: 'product/42', title: '贵人鸟篮球鞋',
      platform: 'jd', accountId: 'jd-store-42',
    })
    expect(destination).toEqual({
      page: 'products', entry: 'products', searchQuery: '贵人鸟篮球鞋',
      catalogContext: { platform: 'jd', accountId: 'jd-store-42', productId: 'product/42' },
    })
    const href = urlForMerchantRoute({ pathname: '/merchant/overview', search: '' }, destination)
    expect(href).toBe('/merchant/products?q=%E8%B4%B5%E4%BA%BA%E9%B8%9F%E7%AF%AE%E7%90%83%E9%9E%8B&section=products&platform=jd&account_id=jd-store-42&product_id=product%2F42')
    expect(merchantRouteFromLocation({ pathname: '/merchant/products', search: new URL(href, 'https://example.test').search, hash: '' })).toEqual({
      page: 'products', entry: 'products', searchQuery: '贵人鸟篮球鞋',
      catalogContext: { platform: 'jd', accountId: 'jd-store-42', productId: 'product/42' },
    })
  })

  it('uses a verified product ID even when older risk data omitted its title', () => {
    expect(merchantRiskDestination({ type: 'MISSING_IMAGES', entityType: 'product', entityId: 'product-id', platform: 'jd', accountId: 'store-id' })).toEqual({
      page: 'products', entry: 'products', catalogContext: { platform: 'jd', accountId: 'store-id', productId: 'product-id' },
    })
  })

  it('sends a manual-mode authorization risk to the matching store status context', () => {
    const destination = merchantRiskDestination({
      type: 'AUTH_RECONNECT', entityType: 'platform_account', entityId: 'jd-store-42',
      platform: 'jd', accountId: 'jd-store-42',
    })
    expect(destination).toEqual({
      page: 'products', entry: 'products',
      catalogContext: { platform: 'jd', accountId: 'jd-store-42', intent: 'authorization' },
    })
    const href = urlForMerchantRoute({ pathname: '/merchant/overview', search: '?q=old&section=knowledge' }, destination)
    expect(href).toBe('/merchant/products?section=products&platform=jd&account_id=jd-store-42&intent=authorization')
    expect(merchantRouteFromLocation({ pathname: '/merchant/products', search: new URL(href, 'https://example.test').search, hash: '' }).catalogContext)
      .toEqual({ platform: 'jd', accountId: 'jd-store-42', intent: 'authorization' })
  })

  it.each(['LOW_STOCK', 'MISSING_IMAGES'])('preserves the catalog search context for %s metrics without entityType', (type) => {
    const title = '贵人鸟儿童运动鞋 雾霾蓝 42'
    const destination = merchantRiskDestination({ type, title, entityId: 'product-id', entityType: undefined })
    expect(destination).toEqual({ page: 'products', entry: 'products', searchQuery: title, catalogContext: { productId: 'product-id' } })
    const href = urlForMerchantRoute({ pathname: '/merchant/overview', search: '' }, destination)
    const parsed = new URL(href, 'https://example.test')
    expect(parsed.searchParams.get('section')).toBe('products')
    expect(parsed.searchParams.get('q')).toBe(title)
    expect(parsed.searchParams.get('product_id')).toBe('product-id')
    expect(merchantRouteFromLocation(parsed)).toEqual({ page: 'products', entry: 'products', searchQuery: title, catalogContext: { productId: 'product-id' } })
  })

  it.each(['LOW_STOCK', 'MISSING_IMAGES'])('does not override an explicit unknown or conflicting entity for %s', (type) => {
    for (const entityType of ['future_entity', '', 'content_version', 'publish_job', 'platform_account', 'sync_job']) {
      const destination = merchantRiskDestination({
        type, entityType, entityId: 'not-a-product', title: '商品标题不能证明实体身份',
        evidence: { taskId: 'must-not-follow-conflicting-task' },
      })
      expect(destination).toEqual({ page: 'overview' })
      expect(urlForMerchantRoute({ pathname: '/merchant/overview', search: '?q=old&section=products' }, destination))
        .toBe('/merchant/overview')
    }
  })

  it('falls back safely when a product has no searchable title', () => {
    for (const title of [undefined, '', ' \t ']) {
      expect(merchantRiskDestination({ type: 'MISSING_IMAGES', entityType: 'product', title }))
        .toEqual({ page: 'overview' })
    }
  })
})
