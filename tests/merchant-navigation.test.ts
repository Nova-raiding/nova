import { describe, expect, it } from 'vitest'
import { merchantPages, merchantRouteFromLocation, urlForMerchantRoute } from '../demo/merchant-studio/src/navigation.js'

describe('Merchant Studio navigation', () => {
  it.each([
    ['overview', 'overview'],
    ['products', 'products'],
    ['tasks', 'task'],
    ['publish', 'publish'],
    ['rules', 'rules'],
  ] as const)('initializes /merchant/%s as %s', (path, page) => {
    expect(merchantRouteFromLocation({ pathname: `/merchant/${path}`, search: '', hash: '' }).page).toBe(page)
    expect(merchantRouteFromLocation({ pathname: `/console/merchant/${path}/`, search: '', hash: '' }).page).toBe(page)
  })

  it('parses a stable task deep link without trusting display metadata', () => {
    expect(merchantRouteFromLocation({ pathname: '/merchant/tasks/task%20one', search: '?store_name=forged', hash: '' })).toEqual({
      page: 'task',
      searchQuery: '',
      target: { kind: 'task', taskId: 'task one' },
    })
  })

  it('parses a new-task product target and ignores invalid platform values', () => {
    expect(merchantRouteFromLocation({ pathname: '/merchant/tasks/new', search: '?product_id=prod-1&platform=taobao&account_id=acct-1&intent=intent-1', hash: '' }).target).toEqual({ kind: 'product', productId: 'prod-1', platform: 'taobao', accountId: 'acct-1', intentKey: 'intent-1' })
    expect(merchantRouteFromLocation({ pathname: '/merchant/tasks/new', search: '?product_id=prod-1&platform=forged', hash: '' }).target).toEqual({ kind: 'product', productId: 'prod-1', platform: undefined, accountId: undefined, intentKey: undefined })
  })

  it('keeps product search and legacy hash bookmarks compatible', () => {
    expect(merchantRouteFromLocation({ pathname: '/merchant/products', search: '?q=%E9%98%B2%E6%99%92', hash: '' }).searchQuery).toBe('防晒')
    expect(merchantRouteFromLocation({ pathname: '/', search: '', hash: '#tasks' }).page).toBe('task')
    for (const page of merchantPages.filter(page => page !== 'task')) {
      expect(merchantRouteFromLocation({ pathname: '/', search: '', hash: `#${page}` }).page).toBe(page)
    }
  })

  it('builds canonical URLs while preserving the deployment base and unrelated query', () => {
    expect(urlForMerchantRoute({ pathname: '/console/merchant/overview', search: '?source=codex&q=old' }, { page: 'products', searchQuery: '防晒 外套' })).toBe('/console/merchant/products?source=codex&q=%E9%98%B2%E6%99%92+%E5%A4%96%E5%A5%97')
    expect(urlForMerchantRoute({ pathname: '/merchant/products', search: '?source=codex' }, { page: 'task', target: { kind: 'task', taskId: 'task/one' } })).toBe('/merchant/tasks/task%2Fone?source=codex')
    expect(urlForMerchantRoute({ pathname: '/merchant/tasks', search: '' }, { page: 'task', target: { kind: 'product', productId: 'prod-1', platform: 'taobao', accountId: 'acct-1' } })).toBe('/merchant/tasks/new?product_id=prod-1&platform=taobao&account_id=acct-1')
    expect(urlForMerchantRoute({ pathname: '/merchant/tasks', search: '' }, { page: 'task', target: { kind: 'product', productId: 'prod-1', intentKey: 'intent-1' } })).toBe('/merchant/tasks/new?product_id=prod-1&intent=intent-1')
  })

  it('falls back safely for unknown or malformed routes', () => {
    expect(merchantRouteFromLocation({ pathname: '/merchant/unknown', search: '', hash: '' })).toEqual({ page: 'overview', searchQuery: '' })
    expect(merchantRouteFromLocation({ pathname: '/merchant/tasks/%E0%A4%A', search: '', hash: '' })).toEqual({ page: 'task', searchQuery: '' })
  })
})
