import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseProductStoreScope, productMatchesStoreScope, productStoreScopeQuery, productStoreScopeValue } from './product-store-filter.js'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const productsComponent = appSource.slice(appSource.indexOf('export function Products('), appSource.indexOf('function ProductDetailPreview('))

describe('merchant product store filter preserves platform identity', () => {
  it('distinguishes accounts that share a remote ID across platforms', () => {
    const jdValue = productStoreScopeValue({ platform: 'jd', accountId: '123' })
    const taobaoValue = productStoreScopeValue({ platform: 'taobao', accountId: '123' })
    expect(jdValue).not.toBe(taobaoValue)
    expect(parseProductStoreScope(jdValue)).toEqual({ platform: 'jd', accountId: '123' })
    expect(parseProductStoreScope(taobaoValue)).toEqual({ platform: 'taobao', accountId: '123' })
    expect(productStoreScopeQuery(parseProductStoreScope(jdValue))).toEqual({ platform: 'jd', accountId: '123' })
  })

  it('round-trips account IDs containing separators and rejects malformed values', () => {
    const value = productStoreScopeValue({ platform: 'tmall', accountId: '店铺:123' })
    expect(parseProductStoreScope(value)).toEqual({ platform: 'tmall', accountId: '店铺:123' })
    expect(parseProductStoreScope('not-a-platform:123')).toBeNull()
    expect(parseProductStoreScope('jd:%E0%A4%A')).toBeNull()
  })

  it('matches offline products by both platform and account ID and wires the same scope into the UI and API request', () => {
    const scope = parseProductStoreScope(productStoreScopeValue({ platform: 'jd', accountId: '123' }))
    expect(productMatchesStoreScope({ platformId: 'jd', accountId: '123' }, scope)).toBe(true)
    expect(productMatchesStoreScope({ platformId: 'taobao', accountId: '123' }, scope)).toBe(false)
    expect(productMatchesStoreScope({ platformId: 'jd', accountId: 'other' }, scope)).toBe(false)
    expect(productsComponent).toContain("value={productStoreScopeValue({ platform: account.platform, accountId: account.accountId ?? '' })}")
    expect(productsComponent).toContain('...productStoreScopeQuery(selectedStoreScope)')
    expect(productsComponent).toContain('productMatchesStoreScope(p, selectedStoreScope)')
  })
})
