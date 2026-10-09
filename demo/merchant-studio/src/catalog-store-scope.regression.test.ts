import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PlatformAccount, Product } from './api'
import { buildCatalogPlatforms, catalogImageGenerationTarget, catalogProductsForStore } from './catalog-data'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

const account = (platform: 'jd' | 'taobao') => ({
  platform,
  accountId: 'shared-remote-account-42',
  label: `${platform} 同号店铺`,
  state: 'connected',
  readEnabled: true,
  writeEnabled: false,
  dataMode: 'official_api',
} as unknown as PlatformAccount)

const product = (platform: 'jd' | 'taobao', id: string, title: string) => ({
  id,
  platform,
  accountId: 'shared-remote-account-42',
  title,
  price: 100,
  stock: 5,
  skuCount: 1,
  skus: [],
} as unknown as Product)

const sharedAccountProducts = [
  product('jd', 'jd-product', '京东商品'),
  product('taobao', 'taobao-product', '淘宝商品'),
]

describe('catalog store scope keeps platform and account identity together', () => {
  it('isolates product rows and per-store counts when two platforms reuse an account ID', () => {
    const stores = buildCatalogPlatforms([account('jd'), account('taobao')], sharedAccountProducts)!
    const jd = stores.find((platform) => platform.id === 'jd')!.stores[0]!
    const taobao = stores.find((platform) => platform.id === 'taobao')!.stores[0]!

    expect(jd.products).toBe(1)
    expect(taobao.products).toBe(1)
    expect(catalogProductsForStore(sharedAccountProducts, { platform: jd.platformId, accountId: jd.id })!.map((item) => item.id)).toEqual(['jd-product'])
    expect(catalogProductsForStore(sharedAccountProducts, { platform: taobao.platformId, accountId: taobao.id })!.map((item) => item.id)).toEqual(['taobao-product'])
  })

  it('only constructs an image-generation target for a product owned by the selected platform and account', () => {
    const jdScope = { platform: 'jd', accountId: 'shared-remote-account-42' }
    expect(catalogImageGenerationTarget(sharedAccountProducts[0], jdScope)).toEqual({
      productId: 'jd-product', platform: 'jd', accountId: 'shared-remote-account-42',
    })
    expect(catalogImageGenerationTarget(sharedAccountProducts[1], jdScope)).toBeNull()
    expect(catalogImageGenerationTarget(sharedAccountProducts[0], { ...jdScope, accountId: 'other-account' })).toBeNull()
  })

  it('wires the same scoped product identity into detail selection and the generation request', () => {
    expect(appSource).toContain('catalogProductsForStore(products, { platform: selectedStore.platformId, accountId: selectedStore.id }')
    expect(appSource).toContain('catalogProductMatchesStoreScope(product, { platform: selectedStore.platformId, accountId: selectedStore.id })')
    expect(appSource).toContain('product_id: target.productId')
    expect(appSource).toContain('platform: target.platform as PlatformId')
    expect(appSource).toContain('account_id: target.accountId')
    expect(appSource).toContain('merchant-studio-image-${target.productId}-${target.platform}-${target.accountId}-')
  })
})
