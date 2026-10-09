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

  it.each(['platform_account', 'sync_job'])('opens %s in the catalog without fabricating a selected task', (entityType) => {
    const destination = merchantRiskDestination({ type: 'AUTH_RECONNECT', entityType, entityId: 'store-or-job', evidence: { taskId: 'irrelevant' } })
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
    expect(destination).toEqual({ page: 'products', entry: 'products', searchQuery: title })
    const parsed = new URL(urlForMerchantRoute({ pathname: '/merchant/overview', search: '' }, destination), 'https://example.test')
    expect(parsed.pathname).toBe('/merchant/products')
    expect(parsed.searchParams.get('section')).toBe('products')
    expect(parsed.searchParams.get('q')).toBe(title)
    expect(parsed.hash).toBe('')
    expect(merchantRouteFromLocation(parsed)).toEqual({ page: 'products', entry: 'products', searchQuery: title })
  })

  it('falls back safely when a product has no searchable title', () => {
    for (const title of [undefined, '', ' \t ']) {
      expect(merchantRiskDestination({ type: 'MISSING_IMAGES', entityType: 'product', entityId: 'product-id', title }))
        .toEqual({ page: 'overview' })
    }
  })
})
