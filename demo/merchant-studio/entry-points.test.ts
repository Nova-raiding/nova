import { describe, expect, it, vi } from 'vitest'
import { assetMatchesEntry, entryPointActionLabel, merchantEntryPointFromQuery } from './src/entry-points.js'
import { focusMainAfterMerchantNavigation, merchantRouteFromLocation, urlForMerchantRoute } from './src/navigation.js'

describe('merchant new-session entry points', () => {
  it('accepts only known entry points', () => {
    expect(merchantEntryPointFromQuery('knowledge')).toBe('knowledge')
    expect(merchantEntryPointFromQuery('images')).toBe('images')
    expect(merchantEntryPointFromQuery('forged')).toBeUndefined()
  })

  it('gives entry cards an explicit, ordered action label', () => {
    expect(entryPointActionLabel(0, '知识库', '品牌资料与规则依据')).toBe('第 1 步：进入知识库，品牌资料与规则依据')
  })

  it('keeps the selected entry in a shareable product URL', () => {
    const url = urlForMerchantRoute({ pathname: '/', search: '' }, { page: 'products', entry: 'assets' })
    expect(url).toBe('/merchant/products?section=assets')
    expect(merchantRouteFromLocation({ pathname: '/merchant/products', search: '?section=assets', hash: '' }).entry).toBe('assets')
  })

  it('round-trips the platform and store catalog entry from the overview', () => {
    const url = urlForMerchantRoute(
      { pathname: '/merchant/overview', search: '' },
      { page: 'products', entry: 'products' },
    )
    expect(url).toBe('/merchant/products?section=products')
    expect(merchantRouteFromLocation({ pathname: '/merchant/products', search: '?section=products', hash: '' }).entry).toBe('products')
  })

  it('keeps the bare product route and broad task destinations on the screenshot-backed materials page', () => {
    expect(merchantRouteFromLocation({ pathname: '/merchant/products', search: '', hash: '' })).toMatchObject({ page: 'products', entry: 'knowledge' })
    expect(merchantRouteFromLocation({ pathname: '/merchant/tasks', search: '', hash: '' })).toEqual({ page: 'task', searchQuery: '' })
    expect(merchantRouteFromLocation({ pathname: '/merchant/publish', search: '', hash: '' })).toEqual({ page: 'products', searchQuery: '' })
    expect(merchantRouteFromLocation({ pathname: '/merchant/rules', search: '', hash: '' })).toEqual({ page: 'products', searchQuery: '' })
  })

  it('keeps the legacy rules workflow scoped to the selected product catalog entry', () => {
    const url = urlForMerchantRoute({ pathname: '/', search: '' }, { page: 'rules', target: { kind: 'product', productId: 'product-a', platform: 'taobao', accountId: 'store-a' } })
    expect(url).toBe('/merchant/rules?product_id=product-a&platform=taobao&account_id=store-a')
    expect(merchantRouteFromLocation({ pathname: '/merchant/rules', search: '?product_id=product-a&platform=taobao&account_id=store-a', hash: '' })).toEqual({ page: 'products', searchQuery: '' })
  })

  it('does not trust malformed or cross-route deep-link identifiers as a local page state', () => {
    expect(merchantRouteFromLocation({ pathname: '/merchant/tasks/%E0%A4%A', search: '', hash: '' }))
      .toMatchObject({ page: 'task', searchQuery: '' })
    expect(merchantRouteFromLocation({ pathname: '/merchant/products', search: '?section=forged&q=%00', hash: '' }))
      .toMatchObject({ page: 'products', entry: 'knowledge', searchQuery: '\u0000' })
  })

  it('preserves unrelated query parameters while replacing route-owned parameters', () => {
    expect(urlForMerchantRoute(
      { pathname: '/merchant/products', search: '?source=codex&q=old&section=images&campaign=launch' },
      { page: 'products', searchQuery: 'new query', entry: 'knowledge' },
    )).toBe('/merchant/products?source=codex&campaign=launch&q=new+query&section=knowledge')

    expect(merchantRouteFromLocation({
      pathname: '/merchant/products',
      search: '?source=codex&campaign=launch&q=new+query&section=knowledge',
      hash: '',
    })).toMatchObject({ page: 'products', searchQuery: 'new query', entry: 'knowledge' })
  })

  it('focuses main after competing one-frame restoration has finished', () => {
    const frames: FrameRequestCallback[] = []
    const scheduleFrame = (callback: FrameRequestCallback) => { frames.push(callback); return frames.length }
    const main = { focus: vi.fn() }

    focusMainAfterMerchantNavigation(main, scheduleFrame, () => false)
    frames.shift()?.(0)
    expect(main.focus).not.toHaveBeenCalled()
    frames.shift()?.(1)
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('does not move focus behind an active modal dialog', () => {
    const frames: FrameRequestCallback[] = []
    const scheduleFrame = (callback: FrameRequestCallback) => { frames.push(callback); return frames.length }
    const main = { focus: vi.fn() }

    focusMainAfterMerchantNavigation(main, scheduleFrame, () => true)
    frames.shift()?.(0)
    frames.shift()?.(1)
    expect(main.focus).not.toHaveBeenCalled()
  })

  it('keeps the screenshot-backed knowledge and image destinations on the shared server asset collection', () => {
    expect(assetMatchesEntry('application/pdf', 'knowledge')).toBe(true)
    expect(assetMatchesEntry('image/png', 'knowledge')).toBe(true)
    expect(assetMatchesEntry('image/png', 'images')).toBe(true)
    expect(assetMatchesEntry('application/pdf', 'images')).toBe(true)
    expect(assetMatchesEntry('application/pdf', 'assets')).toBe(true)
  })
})
