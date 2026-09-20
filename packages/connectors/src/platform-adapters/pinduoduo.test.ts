import { describe, expect, it } from 'vitest'
import { createPinduoduoSigner, mapPinduoduoProducts, mapPinduoduoWriteStatus } from './pinduoduo.js'

describe('Pinduoduo adapter', () => {
  it('builds a sorted MD5 router form with access token', async () => {
    // The router `type` is connector configuration (`api.methods`). The comment
    // it used to carry — "the generic connector supplies the API type in the
    // URL" — described a request the configuration cannot produce, because
    // `api.*Path` must be a relative path without a query string.
    const request = { method: 'POST', url: 'https://open.pinduoduo.com/api/router', headers: {} as Record<string, string>, body: JSON.stringify({ goods_sign: 'sign-1' }), platform: 'pinduoduo' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
    await createPinduoduoSigner({ clientId: 'pdd-app', clientSecret: 'secret', methods: { sync: 'pdd.goods.detail' }, now: () => new Date(2026, 7, 23, 4, 5, 6) }).sign(request)
    const body = new URLSearchParams(request.body)
    expect(body.get('type')).toBe('pdd.goods.detail')
    expect(body.get('access_token')).toBe('token-1')
    expect(body.get('data_type')).toBe('JSON')
    expect(body.get('sign')).toMatch(/^[A-F0-9]{32}$/)
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
  })

  it('signs the GET read path into the URL query so the request stays dispatchable', async () => {
    // `syncProducts` dispatches with GET; a signed form body there makes
    // `fetch` throw "Request with GET/HEAD method cannot have body" before any
    // network call, so the read path never left the process.
    const sign = async (method: string) => {
      const request = { method, url: 'https://open.pinduoduo.com/api/router?cursor=page-2', headers: {} as Record<string, string>, body: JSON.stringify({ goods_sign: 'sign-1' }), platform: 'pinduoduo' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
      await createPinduoduoSigner({ clientId: 'pdd-app', clientSecret: 'secret', methods: { sync: 'pdd.goods.detail' }, now: () => new Date(2026, 7, 23, 4, 5, 6) }).sign(request)
      return request
    }
    const get = await sign('GET')
    expect(get.body).toBeUndefined()
    expect(() => new Request(get.url, { method: 'GET', body: get.body })).not.toThrow()
    const query = new URL(get.url).searchParams
    expect(new URL(get.url).pathname).toBe('/api/router')
    expect(query.get('type')).toBe('pdd.goods.detail')
    expect(query.get('client_id')).toBe('pdd-app')
    expect(query.get('access_token')).toBe('token-1')
    expect(query.get('data_type')).toBe('JSON')
    expect(query.get('sign')).toMatch(/^[A-F0-9]{32}$/)
    // The sync cursor still has to reach the provider.
    expect(query.get('cursor')).toBe('page-2')
    // Same parameters, same signature: only the transport moved.
    const post = await sign('POST')
    expect(new URL(post.url).search).toBe('')
    expect(query.get('sign')).toBe(new URLSearchParams(post.body).get('sign'))
  })

  it('does not let a GET query parameter retarget the signed router type', async () => {
    const request = { method: 'GET', url: 'https://open.pinduoduo.com/api/router?type=pdd.goods.delete', headers: {} as Record<string, string>, platform: 'pinduoduo' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
    await createPinduoduoSigner({ clientId: 'pdd-app', clientSecret: 'secret', methods: { sync: 'pdd.goods.detail' }, now: () => new Date(2026, 7, 23, 4, 5, 6) }).sign(request)
    expect(new URL(request.url).searchParams.getAll('type')).toEqual(['pdd.goods.detail'])
  })

  it('refuses to sign an operation whose router type is not configured', async () => {
    const request = { method: 'POST', url: 'https://open.pinduoduo.com/api/router', headers: {} as Record<string, string>, body: '{}', platform: 'pinduoduo' as const, operation: 'create_product' as const }
    await expect(Promise.resolve().then(() => createPinduoduoSigner({ clientId: 'pdd-app', clientSecret: 'secret' }).sign(request)))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false, message: expect.stringContaining('api.methods.create') })
  })

  it('maps goods_sign as the stable remote identity', () => {
    const [product] = mapPinduoduoProducts({ goods_search_response: { goods_list: [{ goods_sign: 'gs-1', goods_name: '拼多多商品', min_group_price: 1299, goods_image_url: 'https://img.example/pdd.jpg', stock: 8 }] } })
    expect(product).toMatchObject({ remoteId: 'gs-1', title: '拼多多商品', price: 12.99, stock: 8 })
    expect(mapPinduoduoWriteStatus({ success: true, goods_sign: 'gs-1' }, { idempotencyKey: 'pdd-1' })).toMatchObject({ found: true, state: 'submitted', remoteId: 'gs-1' })
  })

  it('converts fen to yuan for every product, including prices at or below 10.00 yuan', () => {
    // Pinduoduo quotes prices in fen (the case above: 1299 fen -> 12.99 yuan).
    // The previous `> 1000 ? /100 : /1` heuristic was not monotonic: 990 fen
    // stayed 990, 1000 fen stayed 1000 and 1001 fen became 10.01, so every
    // product at or below 10.00 yuan was persisted at 100x its real price.
    const products = mapPinduoduoProducts({ goods_search_response: { goods_list: [
      { goods_sign: 'gs-990', goods_name: '9.90 元', min_group_price: 990 },
      { goods_sign: 'gs-1000', goods_name: '10.00 元', min_group_price: 1000 },
      { goods_sign: 'gs-1001', goods_name: '10.01 元', min_group_price: 1001 },
      { goods_sign: 'gs-normal', goods_name: '不带拼团价', min_normal_price: '250' },
    ] } })
    expect(products.map(product => product.price)).toEqual([9.9, 10, 10.01, 2.5])
    expect(products.map(product => product.remoteId)).toEqual(['gs-990', 'gs-1000', 'gs-1001', 'gs-normal'])
  })

  it('does not use the local idempotency key as provider request evidence', () => {
    expect(mapPinduoduoWriteStatus({ success: true, goods_sign: 'gs-1' }, { idempotencyKey: 'local-only' })).not.toHaveProperty('requestId')
  })

  it('maps a rejected status even when no remote product id was assigned', () => {
    expect(mapPinduoduoWriteStatus({ state: 'rejected', rejection: { raw_code: 'PDD-SKU-101', message: 'SKU 信息错误', fields: [{ path: 'sku.price', raw_code: 'PRICE_RANGE', message: '价格超出范围' }] } }, { idempotencyKey: 'pdd-rejected' })).toMatchObject({
      found: true, state: 'rejected', rejection: { rawCode: 'PDD-SKU-101', fields: [{ path: 'sku.price', rawCode: 'PRICE_RANGE' }] },
    })
  })

  it('reads nested provider task identity and infers rejection from error evidence', () => {
    expect(mapPinduoduoWriteStatus({ result: { goods_sign: 'gs-1', task_id: 'pdd-task-1', error_response: { error_code: 'PDD-400', error_msg: '商品校验失败' } } }, { idempotencyKey: 'pdd-nested' })).toMatchObject({
      found: true, state: 'rejected', remoteId: 'gs-1', requestId: 'pdd-task-1', rejection: { rawCode: 'PDD-400', message: '商品校验失败' },
    })
  })
})
