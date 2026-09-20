import { describe, expect, it } from 'vitest'
import { createAlibabaTopSigner, mapAlibabaTopProducts, mapAlibabaTopWriteStatus } from './alibaba-top.js'

describe('Alibaba TOP signer', () => {
  it('builds a signed form request from the configured method, session and business parameters', async () => {
    // TOP's `method` is connector configuration (`api.methods`), not a URL
    // query parameter: the URL is built from `api.*Path`, which readiness
    // requires to be a relative path without a query string, so a `?method=`
    // could never be configured. It used to be read from the URL anyway.
    const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest', headers: {} as Record<string, string>, body: JSON.stringify({ fields: 'num_iid,title', num_iid: '11223344' }), platform: 'taobao' as const, operation: 'sync_products' as const, credential: { accessToken: 'session-1' } }
    const signer = createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', methods: { sync: 'taobao.item.seller.get' }, now: () => new Date('2026-08-23T04:05:06Z') })
    await signer.sign(request)
    const body = new URLSearchParams(request.body)
    expect(request.url).toBe('https://gw.api.taobao.com/router/rest')
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
    expect(body.get('method')).toBe('taobao.item.seller.get')
    expect(body.get('session')).toBe('session-1')
    expect(body.get('timestamp')).toBe('2026-08-23 12:05:06')
    expect(body.get('sign')).toMatch(/^[A-F0-9]{64}$/)
  })

  it('signs each operation with its own configured TOP method instead of one shared method', async () => {
    // Previously every request either threw (no `?method=` in the URL can be
    // configured at all) or was signed with whatever the URL happened to carry.
    const operations = [
      ['sync_products', 'sync', 'taobao.item.seller.get'],
      ['create_product', 'create', 'taobao.item.add'],
      ['update_product', 'update', 'taobao.item.update'],
      ['query_write', 'query', 'taobao.item.get'],
    ] as const
    const methods = Object.fromEntries(operations.map(([, selector, method]) => [selector, method]))
    const signed: string[] = []
    for (const [operation, , method] of operations) {
      const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest', headers: {} as Record<string, string>, body: JSON.stringify({ num_iid: '11223344' }), platform: 'taobao' as const, operation, credential: { accessToken: 'session-1' } }
      await createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', methods, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
      signed.push(new URLSearchParams(request.body).get('method')!)
      expect(new URLSearchParams(request.body).get('method')).toBe(method)
    }
    expect(signed).toEqual(['taobao.item.seller.get', 'taobao.item.add', 'taobao.item.update', 'taobao.item.get'])
  })

  it('ignores a method smuggled in through the URL query', async () => {
    const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest?method=tmall.item.delete', headers: {} as Record<string, string>, body: JSON.stringify({ num_iid: '11223344' }), platform: 'taobao' as const, operation: 'query_write' as const, credential: { accessToken: 'session-1' } }
    await createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', methods: { query: 'taobao.item.get' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    expect(new URLSearchParams(request.body).get('method')).toBe('taobao.item.get')
  })

  it('does not let a business field override the configured TOP method', async () => {
    // TOP merges the JSON body into the signed form, so a writable draft field
    // named `method` must not be able to retarget the call.
    const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest', headers: {} as Record<string, string>, body: JSON.stringify({ method: 'taobao.item.delete', num_iid: '11223344' }), platform: 'taobao' as const, operation: 'update_product' as const, credential: { accessToken: 'session-1' } }
    await createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', methods: { update: 'taobao.item.update' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    expect(new URLSearchParams(request.body).get('method')).toBe('taobao.item.update')
  })

  it('keeps the read path session out of the URL and carries the cursor in the body', async () => {
    // The read path is dispatched as POST. It used to be a GET whose signed
    // parameters were written into the query string, which put TOP's `session`
    // (the real access token) in the request line of every hop that logs one.
    const request: { method: string; url: string; headers: Record<string, string>; body?: string; platform: 'taobao'; operation: 'sync_products'; credential: { accessToken: string } } = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest?cursor=page-2&updated_since=2026-01-01T00:00:00Z', headers: {}, body: JSON.stringify({ fields: 'num_iid,title' }), platform: 'taobao', operation: 'sync_products', credential: { accessToken: 'session-1' } }
    await createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', methods: { sync: 'taobao.item.seller.get' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    const url = new URL(request.url)
    expect(url.pathname).toBe('/router/rest')
    expect(url.search).toBe('')
    expect(request.url).not.toContain('session-1')
    const body = new URLSearchParams(request.body)
    expect(body.get('method')).toBe('taobao.item.seller.get')
    expect(body.get('app_key')).toBe('12345678')
    expect(body.get('session')).toBe('session-1')
    expect(body.get('timestamp')).toBe('2026-08-23 12:05:06')
    expect(body.get('sign_method')).toBe('hmac-sha256')
    expect(body.get('sign')).toMatch(/^[A-F0-9]{64}$/)
    // The sync cursor, window and business fields still reach the provider.
    expect(body.get('cursor')).toBe('page-2')
    expect(body.get('updated_since')).toBe('2026-01-01T00:00:00Z')
    expect(body.get('fields')).toBe('num_iid,title')
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
  })

  it('refuses the read path on a bodyless method instead of publishing the session', async () => {
    const request = { method: 'GET', url: 'https://gw.api.taobao.com/router/rest', headers: {} as Record<string, string>, body: JSON.stringify({ fields: 'title' }), platform: 'taobao' as const, operation: 'sync_products' as const, credential: { accessToken: 'session-1' } }
    await expect(Promise.resolve().then(() => createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', methods: { sync: 'taobao.item.seller.get' } }).sign(request)))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false, message: expect.stringContaining('credentials must stay out of the URL') })
    expect(new URL(request.url).search).toBe('')
  })

  it('drops a method smuggled in through the URL query instead of signing it', async () => {
    const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest?method=tmall.item.delete', headers: {} as Record<string, string>, body: JSON.stringify({ num_iid: '11223344' }), platform: 'taobao' as const, operation: 'sync_products' as const, credential: { accessToken: 'session-1' } }
    await createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', methods: { sync: 'taobao.item.seller.get' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    expect(new URL(request.url).search).toBe('')
    const body = new URLSearchParams(request.body)
    expect(body.get('method')).toBe('taobao.item.seller.get')
    expect(body.get('session')).toBe('session-1')
  })

  it('refuses to sign an operation whose TOP method is not configured', async () => {
    // The old failure mode was a throw on *every* request ("TOP request URL
    // must include method") that escaped the connector's provider-error catch
    // and was re-derived by the publish path as a retryable REMOTE_ERROR. The
    // refusal now names the missing selector and is terminal.
    const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest', headers: {} as Record<string, string>, body: '{}', platform: 'taobao' as const, operation: 'create_product' as const }
    await expect(Promise.resolve().then(() => createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret' }).sign(request)))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false, message: expect.stringContaining('api.methods.create') })
  })

  it('supports the legacy TOP md5 signature mode', async () => {
    const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest', headers: {} as Record<string, string>, body: JSON.stringify({ fields: 'title' }), platform: 'taobao' as const, operation: 'sync_products' as const }
    const signer = createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', signMethod: 'md5', methods: { sync: 'taobao.item.seller.get' }, now: () => new Date('2026-08-23T04:05:06Z') })
    await signer.sign(request)
    const body = new URLSearchParams(request.body)
    expect(body.get('sign')).toBe('3A6B5BA64522D4A813BDD7BA7DEBF3AE')
  })

  it('maps common TOP item and status envelopes without inventing confirmation', () => {
    const [product] = mapAlibabaTopProducts({ items: { item: [{ num_iid: 1122, title: 'TOP 商品', price: '19.90', num: 7, pic_url: 'https://img.example/item.jpg' }] } }, 'taobao')
    expect(product).toMatchObject({ remoteId: '1122', title: 'TOP 商品', price: 19.9, stock: 7 })
    expect(mapAlibabaTopWriteStatus({ success: true, num_iid: 1122 }, { idempotencyKey: 'req-1' }, 'taobao')).toMatchObject({ found: true, state: 'submitted', remoteId: '1122' })
  })

  it.each(['taobao', 'tmall'] as const)('reads products from a controlled nested response envelope for %s', platform => {
    const [product] = mapAlibabaTopProducts({ response: { data: { items: { item: [{ num_iid: 3344, title: `${platform} nested` }] } } } }, platform)
    expect(product).toMatchObject({ remoteId: '3344', title: `${platform} nested` })
  })

  it.each(['taobao', 'tmall'] as const)('does not use the local idempotency key as provider request evidence for %s', platform => {
    expect(mapAlibabaTopWriteStatus({ success: true, num_iid: 1122 }, { idempotencyKey: 'local-only' }, platform)).not.toHaveProperty('requestId')
  })

  it.each(['taobao', 'tmall'] as const)('maps %s rejection evidence independently', platform => {
    expect(mapAlibabaTopWriteStatus({ found: true, state: 'rejected', error_response: { code: 27, sub_msg: '类目属性缺失', errors: [{ property: 'cid', sub_code: 'MISSING', msg: '请选择类目' }] } }, { idempotencyKey: `${platform}-rejected` }, platform)).toMatchObject({
      state: 'rejected', rejection: { rawCode: '27', message: '类目属性缺失', fields: [{ path: 'cid', rawCode: 'MISSING', message: '请选择类目' }] },
    })
  })

  it.each(['taobao', 'tmall'] as const)('reads nested TOP response identity and error evidence for %s', platform => {
    expect(mapAlibabaTopWriteStatus({ response: { item_id: 1122, provider_request_id: `${platform}-provider-1`, error_response: { code: 27, sub_msg: '类目属性缺失' } } }, { idempotencyKey: `${platform}-nested` }, platform)).toMatchObject({
      found: true, state: 'rejected', remoteId: '1122', requestId: `${platform}-provider-1`, rejection: { rawCode: '27', message: '类目属性缺失' },
    })
  })
})
