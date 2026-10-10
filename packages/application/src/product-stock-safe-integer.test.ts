import { describe, expect, it } from 'vitest'
import { MerchantService } from './service.js'

describe('product stock safe integer boundaries', () => {
  it('validates every synchronized item before writing any product', () => {
    const service = new MerchantService({ seedFixture: false })
    expect(() => service.upsertSyncedProducts({
      workspaceId: 'ws_sync_stock',
      platform: 'jd',
      items: [
        { remoteId: 'valid-first', title: '有效商品', sku: [], stock: 2, source: 'official_api' },
        { remoteId: 'unsafe-second', title: '超限商品', sku: [], stock: Number.MAX_SAFE_INTEGER + 1, source: 'official_api' },
      ],
    })).toThrowError(expect.objectContaining({ code: 'PRODUCT_SYNC_STOCK_INVALID' }))
    expect(service.listProducts('ws_sync_stock')).toEqual([])
  })

  it('rejects unsafe SKU stock values and totals from synchronized data', () => {
    const service = new MerchantService({ seedFixture: false })
    expect(() => service.upsertSyncedProducts({
      workspaceId: 'ws_sync_sku_stock',
      platform: 'jd',
      items: [{ remoteId: 'unsafe-sku', title: '超限SKU', sku: [{ id: 'sku-1', name: '超限', price: 1, stock: Number.MAX_SAFE_INTEGER + 1 }], stock: 1, source: 'official_api' }],
    })).toThrowError(expect.objectContaining({ code: 'PRODUCT_SYNC_SKU_STOCK_INVALID' }))
    expect(() => service.upsertSyncedProducts({
      workspaceId: 'ws_sync_sku_stock',
      platform: 'jd',
      items: [{ remoteId: 'unsafe-total', title: '超限合计', sku: [{ id: 'sku-1', stock: Number.MAX_SAFE_INTEGER }, { id: 'sku-2', stock: 1 }], stock: 1, source: 'official_api' }],
    })).toThrowError(expect.objectContaining({ code: 'PRODUCT_SYNC_SKU_STOCK_TOTAL_INVALID' }))
    expect(service.listProducts('ws_sync_sku_stock')).toEqual([])
  })

  it('rejects SKU totals that cannot be represented safely on import or update', () => {
    const service = new MerchantService({ seedFixture: false })
    expect(() => service.importProduct({
      workspaceId: 'ws_sku_total',
      platform: 'jd',
      title: '导入超限合计',
      skus: [{ id: 'sku-a', name: 'A', price: 1, stock: Number.MAX_SAFE_INTEGER }, { id: 'sku-b', name: 'B', price: 1, stock: 1 }],
    })).toThrowError(expect.objectContaining({ code: 'PRODUCT_IMPORT_SKU_STOCK_TOTAL_INVALID' }))

    const imported = service.importProduct({
      workspaceId: 'ws_sku_total',
      platform: 'jd',
      title: '更新超限合计',
      stock: 0,
      skus: [{ id: 'sku-a', name: 'A', price: 1, stock: Number.MAX_SAFE_INTEGER }, { id: 'sku-b', name: 'B', price: 1, stock: 0 }],
    })
    expect(() => service.updateProductSku({ workspaceId: 'ws_sku_total', productId: imported.id, skuId: 'sku-b', stock: 1 })).toThrowError(expect.objectContaining({ code: 'SKU_STOCK_TOTAL_INVALID' }))
    expect(service.products.get(imported.id)).toMatchObject({ stock: 0, version: imported.version, skus: [{ id: 'sku-a', stock: Number.MAX_SAFE_INTEGER }, { id: 'sku-b', stock: 0 }] })
  })
})
