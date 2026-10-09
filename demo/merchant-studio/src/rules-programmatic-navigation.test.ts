import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { merchantNavigationPage, merchantRouteFromLocation, urlForMerchantRoute } from './navigation.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('merchant rules page navigation', () => {
  it('keeps programmatic rules navigation on the dedicated rules page', () => {
    expect(merchantNavigationPage('rules')).toBe('rules')
    expect(app).toContain('const effectivePage: Page = merchantNavigationPage(nextPage)')
    expect(app).toContain("{page === 'rules' && <Rules baseUrl={apiBaseUrl} target={target} />}")
  })

  it('passes the restored product and store target from a rules deep link into Rules', () => {
    const route = merchantRouteFromLocation({
      pathname: '/merchant/rules',
      search: '?product_id=product-a&platform=taobao&account_id=store-a',
      hash: '',
    })
    expect(route).toMatchObject({
      page: 'rules',
      target: { kind: 'product', productId: 'product-a', platform: 'taobao', accountId: 'store-a' },
    })
    // The app resolves the route target to a server-backed Target before
    // rendering Rules, which uses it to label platform/store scope.
    expect(app).toContain("{page === 'rules' && <Rules baseUrl={apiBaseUrl} target={target} />}")
  })

  it('makes the dedicated rules page discoverable from the merchant sidebar', () => {
    expect(app).toContain("{ id: 'rules', label: '规则与类目', icon: ShieldCheck")
  })

  it('clears a prior route target when the sidebar opens unscoped Rules', () => {
    // Sidebar navigation goes through navigateTo without a target. The route
    // state must follow the new URL instead of retaining the previous product
    // or task context in memory.
    expect(app).toContain('setTarget(resolvedTarget)')
    expect(app).not.toContain("if (effectivePage === 'task') setTarget(resolvedTarget)")

    const url = urlForMerchantRoute(
      { pathname: '/merchant/tasks/task-1', search: '?product_id=old-product&platform=taobao&account_id=old-store' },
      { page: 'rules' },
    )
    expect(url).toBe('/merchant/rules')
  })

  it('retains explicit product scope in direct Rules links', () => {
    const url = urlForMerchantRoute(
      { pathname: '/merchant/rules', search: '' },
      { page: 'rules', target: { kind: 'product', productId: 'product-a', platform: 'taobao', accountId: 'store-a' } },
    )
    expect(url).toBe('/merchant/rules?product_id=product-a&platform=taobao&account_id=store-a')
    expect(merchantRouteFromLocation({ pathname: '/merchant/rules', search: url.split('?')[1] ?? '', hash: '' })).toMatchObject({
      page: 'rules',
      target: { kind: 'product', productId: 'product-a', platform: 'taobao', accountId: 'store-a' },
    })
  })
})
