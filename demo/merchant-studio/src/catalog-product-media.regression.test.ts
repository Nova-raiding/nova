import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Product } from './api'
import { catalogProductImageUrls, catalogProductsForStore } from './catalog-data'

const scope = { platform: 'jd', accountId: 'store-1' }

describe('catalog product media truth', () => {
  it('accepts only absolute HTTPS URLs without credentials from Product.images', () => {
    expect(catalogProductImageUrls([
      'https://cdn.example/item.jpg',
      'https://cdn.example/item.jpg',
      'http://cdn.example/item-2.jpg',
      'https://user:secret@cdn.example/private.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '/relative/item.jpg',
      null,
    ])).toEqual(['https://cdn.example/item.jpg'])
  })

  it('keeps a missing image list empty instead of inventing gallery media', () => {
    const product: Product = {
      id: 'p-1', workspaceId: 'ws-1', platform: 'jd', accountId: 'store-1', storeName: '店铺',
      title: '商品', skuCount: 0, stock: 0, factsConfirmed: true, source: 'manual', updatedAt: '2026-01-01T00:00:00Z',
    }
    expect(catalogProductsForStore([product], scope, {} )?.[0]?.images).toEqual([])
  })

  it('pins source wiring for product API images, empty states, and broken-image fallback', () => {
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const detailStart = source.indexOf('if (selectedStore && selectedProduct)')
    const detailEnd = source.indexOf('if (selectedStore) {', detailStart + 1)
    const detail = source.slice(detailStart, detailEnd)
    expect(detail).toContain('const galleryMedia = selectedProduct.images')
    expect(detail).toContain('暂无商品媒体')
    expect(detail).not.toContain('播放商品视频')
    expect(detail).not.toContain("label: '使用场景'")
    expect(detail).not.toContain("label: '材质细节'")
    expect(detail).not.toContain("label: '尺寸说明'")
    expect(source).toContain('function CatalogProductMediaImage(')
    expect(source).toContain('onError={() => setFailed(true)}')
    expect(source).toContain('>图片暂不可用</span>')
    expect(source).toContain('referrerPolicy="no-referrer"')
    expect(source).toContain('className="catalog-product-card-media"')
    expect(source).toContain('product.images[0]')
    expect(source).toContain('暂无商品图片')
  })
})
