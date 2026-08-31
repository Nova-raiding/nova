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

  it('preserves the current product platform and store scope when opening rules', () => {
    const url = urlForMerchantRoute({ pathname: '/', search: '' }, { page: 'rules', target: { kind: 'product', productId: 'product-a', platform: 'taobao', accountId: 'store-a' } })
    expect(url).toBe('/merchant/rules?product_id=product-a&platform=taobao&account_id=store-a')
    expect(merchantRouteFromLocation({ pathname: '/merchant/rules', search: '?product_id=product-a&platform=taobao&account_id=store-a', hash: '' })).toMatchObject({ page: 'rules', target: { kind: 'product', productId: 'product-a', platform: 'taobao', accountId: 'store-a' } })
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

  it('separates knowledge documents from images while assets includes both', () => {
    expect(assetMatchesEntry('application/pdf', 'knowledge')).toBe(true)
    expect(assetMatchesEntry('image/png', 'knowledge')).toBe(false)
    expect(assetMatchesEntry('image/png', 'images')).toBe(true)
    expect(assetMatchesEntry('application/pdf', 'assets')).toBe(true)
  })
})
