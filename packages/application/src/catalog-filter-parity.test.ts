import { describe, expect, it } from 'vitest'
import { MerchantService } from './service.js'

describe('in-memory catalog filter parity', () => {
  it('treats whitespace-only product and task queries as absent filters', () => {
    const service = new MerchantService()
    const product = service.importProduct({ workspaceId: 'ws_query_parity', platform: 'jd', remoteId: 'jd-1', title: '商品', storeName: '旗舰店' })
    const task = service.createTask({ workspaceId: 'ws_query_parity', productId: product.id, platform: 'jd' })

    expect(service.listProducts('ws_query_parity', { query: '   ' })).toEqual([product])
    expect(service.listTasks('ws_query_parity', { query: '   ' })).toEqual([task])
  })

  it('treats whitespace-only store and brand filters as absent for products and tasks', () => {
    const service = new MerchantService()
    const product = service.importProduct({ workspaceId: 'ws_filter_parity', platform: 'jd', remoteId: 'jd-1', title: '无商品品牌', storeName: '旗舰店' })
    const task = service.createTask({ workspaceId: 'ws_filter_parity', productId: product.id, platform: 'jd' })

    expect(service.listProducts('ws_filter_parity', { storeName: '   ', brandName: '   ' })).toEqual([product])
    expect(service.listTasks('ws_filter_parity', { storeName: '   ', brandName: '   ' })).toEqual([task])
  })

  it('matches the canonical workspace brand profile for products and tasks', () => {
    const service = new MerchantService()
    const product = service.importProduct({ workspaceId: 'ws_brand_parity', platform: 'jd', remoteId: 'jd-brand', title: '商品', storeName: '旗舰店' })
    service.upsertBrandProfile({ workspaceId: 'ws_brand_parity', name: '云朵轻户外' })
    const task = service.createTask({ workspaceId: 'ws_brand_parity', productId: product.id, platform: 'jd' })

    expect(service.listProducts('ws_brand_parity', { brandName: '云朵' })).toEqual([product])
    expect(service.listTasks('ws_brand_parity', { brandName: '云朵' })).toEqual([task])
  })

  it('matches tasks by the associated product store name', () => {
    const service = new MerchantService()
    const product = service.importProduct({ workspaceId: 'ws_task_store_search', platform: 'jd', title: '商品', storeName: '杭州旗舰店' })
    const task = service.createTask({ workspaceId: 'ws_task_store_search', productId: product.id, platform: 'jd' })

    expect(service.listTasks('ws_task_store_search', { query: '杭州旗舰' })).toEqual([task])
    expect(service.listTasks('ws_task_store_search', { query: '不存在的店铺' })).toEqual([])
  })
})
