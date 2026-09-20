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

  it('keeps the read path access token out of the URL and carries the cursor in the body', async () => {
    // The read path is dispatched as POST. It used to be a GET whose signed
    // parameters were written into the query string, which put the real
    // `access_token` in the request line of every hop that logs one.
    const request: { method: string; url: string; headers: Record<string, string>; body?: string; platform: 'pinduoduo'; operation: 'sync_products'; credential: { accessToken: string } } = { method: 'POST', url: 'https://open.pinduoduo.com/api/router?cursor=page-2', headers: {}, body: JSON.stringify({ goods_sign: 'sign-1' }), platform: 'pinduoduo', operation: 'sync_products', credential: { accessToken: 'token-1' } }
    await createPinduoduoSigner({ clientId: 'pdd-app', clientSecret: 'secret', methods: { sync: 'pdd.goods.detail' }, now: () => new Date(2026, 7, 23, 4, 5, 6) }).sign(request)
    const url = new URL(request.url)
    expect(url.pathname).toBe('/api/router')
    expect(url.search).toBe('')
    expect(request.url).not.toContain('token-1')
    const body = new URLSearchParams(request.body)
    expect(body.get('type')).toBe('pdd.goods.detail')
    expect(body.get('client_id')).toBe('pdd-app')
    expect(body.get('access_token')).toBe('token-1')
    expect(body.get('data_type')).toBe('JSON')
    expect(body.get('sign')).toMatch(/^[A-F0-9]{32}$/)
    // The sync cursor still reaches the provider.
    expect(body.get('cursor')).toBe('page-2')
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
  })

  it('refuses the read path on a bodyless method instead of publishing the access token', async () => {
    const request = { method: 'GET', url: 'https://open.pinduoduo.com/api/router', headers: {} as Record<string, string>, body: JSON.stringify({ goods_sign: 'sign-1' }), platform: 'pinduoduo' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
    await expect(Promise.resolve().then(() => createPinduoduoSigner({ clientId: 'pdd-app', clientSecret: 'secret', methods: { sync: 'pdd.goods.detail' } }).sign(request)))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false, message: expect.stringContaining('credentials must stay out of the URL') })
    expect(new URL(request.url).search).toBe('')
  })

  it('drops a type smuggled in through the URL query instead of signing it', async () => {
    const request = { method: 'POST', url: 'https://open.pinduoduo.com/api/router?type=pdd.goods.delete', headers: {} as Record<string, string>, body: JSON.stringify({ goods_sign: 'sign-1' }), platform: 'pinduoduo' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
    await createPinduoduoSigner({ clientId: 'pdd-app', clientSecret: 'secret', methods: { sync: 'pdd.goods.detail' }, now: () => new Date(2026, 7, 23, 4, 5, 6) }).sign(request)
    expect(new URL(request.url).search).toBe('')
    const body = new URLSearchParams(request.body)
    expect(body.get('type')).toBe('pdd.goods.detail')
    expect(body.get('access_token')).toBe('token-1')
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
