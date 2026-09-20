import { describe, expect, it } from 'vitest'
import { createJdSigner, mapJdProducts, mapJdWriteStatus } from './jd.js'

describe('JD Open Platform adapter', () => {
  it('builds the documented routerjson MD5 form signature', async () => {
    // The router `method` is connector configuration (`api.methods`), not a URL
    // query parameter: the URL is built from `api.*Path`, which readiness
    // requires to be a relative path without a query string, so a `?method=`
    // could never be configured. The MD5 above/below is unchanged by moving the
    // selector into configuration.
    const request = { method: 'POST', url: 'https://api.jd.com/routerjson', headers: {} as Record<string, string>, body: JSON.stringify({ ware_id: '1' }), platform: 'jd' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
    await createJdSigner({ appKey: 'jd-app', appSecret: 'secret', methods: { sync: 'jd.product.sync' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    const body = new URLSearchParams(request.body)
    expect(body.get('method')).toBe('jd.product.sync')
    expect(body.get('360buy_param_json')).toBe('{"ware_id":"1"}')
    expect(body.get('access_token')).toBe('token-1')
    expect(body.get('timestamp')).toBe('2026-08-23 12:05:06')
    expect(body.get('sign')).toBe('1BEB12E427C2BF00A37FC5CA490FA3DE')
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
  })

  it('signs create, update and query with their own router methods', async () => {
    // `params.method = params.method ?? 'jd.product.sync'` signed every
    // operation as the sync API, because `params.method` could only ever come
    // from a URL query string that the configuration cannot produce: writes and
    // status queries were sent to the product-search API.
    const operations = [
      ['create_product', 'create', 'jingdong.ware.create'],
      ['update_product', 'update', 'jingdong.ware.update'],
      ['query_write', 'query', 'jingdong.ware.status.get'],
    ] as const
    const methods = Object.fromEntries(operations.map(([, selector, method]) => [selector, method]))
    for (const [operation, , method] of operations) {
      const request = { method: 'POST', url: 'https://api.jd.com/routerjson', headers: {} as Record<string, string>, body: JSON.stringify({ ware_id: '1' }), platform: 'jd' as const, operation, credential: { accessToken: 'token-1' } }
      await createJdSigner({ appKey: 'jd-app', appSecret: 'secret', methods: { sync: 'jd.product.sync', ...methods }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
      expect(new URLSearchParams(request.body).get('method')).toBe(method)
      expect(new URLSearchParams(request.body).get('method')).not.toBe('jd.product.sync')
    }
  })

  it('ignores a method smuggled in through the URL query', async () => {
    const request = { method: 'POST', url: 'https://api.jd.com/routerjson?method=jd.ware.delete', headers: {} as Record<string, string>, body: JSON.stringify({ ware_id: '1' }), platform: 'jd' as const, operation: 'query_write' as const, credential: { accessToken: 'token-1' } }
    await createJdSigner({ appKey: 'jd-app', appSecret: 'secret', methods: { query: 'jingdong.ware.status.get' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    expect(new URLSearchParams(request.body).get('method')).toBe('jingdong.ware.status.get')
  })

  it('keeps the read path credential out of the URL', async () => {
    // The read path is dispatched as POST, exactly like the write path. It used
    // to be a GET whose signed parameters — access_token, app_key and the
    // signature included — were written into the query string, which every hop
    // that logs a request line could then read.
    const request: { method: string; url: string; headers: Record<string, string>; body?: string; platform: 'jd'; operation: 'sync_products'; credential: { accessToken: string } } = { method: 'POST', url: 'https://api.jd.com/routerjson?cursor=page-2', headers: {}, platform: 'jd', operation: 'sync_products', credential: { accessToken: 'token-1' } }
    await createJdSigner({ appKey: 'jd-app', appSecret: 'secret', methods: { sync: 'jd.product.sync' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    const url = new URL(request.url)
    expect(url.pathname).toBe('/routerjson')
    expect(url.search).toBe('')
    expect(request.url).not.toContain('token-1')
    const body = new URLSearchParams(request.body)
    expect(body.get('method')).toBe('jd.product.sync')
    expect(body.get('360buy_param_json')).toBe('{}')
    expect(body.get('access_token')).toBe('token-1')
    expect(body.get('app_key')).toBe('jd-app')
    expect(body.get('timestamp')).toBe('2026-08-23 12:05:06')
    expect(body.get('cursor')).toBe('page-2')
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
  })

  it('refuses the read path on a bodyless method instead of publishing the credential', async () => {
    // Fail closed: there is no transport for a signed parameter set on GET/HEAD
    // that does not put the access token in the URL, so the signer must refuse
    // rather than silently choose the query string.
    const request: { method: string; url: string; headers: Record<string, string>; body?: string; platform: 'jd'; operation: 'sync_products'; credential: { accessToken: string } } = { method: 'GET', url: 'https://api.jd.com/routerjson', headers: {}, platform: 'jd', operation: 'sync_products', credential: { accessToken: 'token-1' } }
    await expect(Promise.resolve().then(() => createJdSigner({ appKey: 'jd-app', appSecret: 'secret', methods: { sync: 'jd.product.sync' } }).sign(request)))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false, message: expect.stringContaining('credentials must stay out of the URL') })
    expect(request.body).toBeUndefined()
    expect(new URL(request.url).search).toBe('')
  })

  it('drops a method smuggled in through the URL query instead of signing it', async () => {
    const request = { method: 'POST', url: 'https://api.jd.com/routerjson?method=jd.ware.delete', headers: {} as Record<string, string>, body: JSON.stringify({ ware_id: '1' }), platform: 'jd' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
    await createJdSigner({ appKey: 'jd-app', appSecret: 'secret', methods: { sync: 'jd.product.sync' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    // The URL is cleared, so the smuggled value is neither dispatched nor
    // signed; only the configured selector reaches the gateway.
    expect(new URL(request.url).search).toBe('')
    expect(new URLSearchParams(request.body).get('method')).toBe('jd.product.sync')
  })

  it('refuses to sign an operation whose router method is not configured', async () => {
    const request = { method: 'POST', url: 'https://api.jd.com/routerjson', headers: {} as Record<string, string>, body: JSON.stringify({ ware_id: '1' }), platform: 'jd' as const, operation: 'create_product' as const, credential: { accessToken: 'token-1' } }
    await expect(Promise.resolve().then(() => createJdSigner({ appKey: 'jd-app', appSecret: 'secret' }).sign(request)))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false, message: expect.stringContaining('api.methods.create') })
  })

  it('maps conservative product and status envelopes', () => {
    const [product] = mapJdProducts({ result: { products: [{ ware_id: 100, title: '京东商品', jd_price: '12.5', stock: 4 }] } })
    expect(product).toMatchObject({ remoteId: '100', title: '京东商品', price: 12.5, stock: 4 })
    expect(mapJdWriteStatus({ success: true, ware_id: 100 }, { idempotencyKey: 'jd-1' })).toMatchObject({ found: true, state: 'submitted', remoteId: '100' })
  })

  it('does not invent provider identity when status omits request evidence', () => {
    expect(mapJdWriteStatus({ success: true, ware_id: 100 }, { idempotencyKey: 'local-only' })).not.toHaveProperty('requestId')
  })

  it('keeps safe field-level rejection evidence', () => {
    expect(mapJdWriteStatus({ found: true, state: 'rejected', error_code: 'JD-ATTR-400', message: '属性不符合类目规则', field_errors: [{ field: 'title', code: 'TITLE-LONG', message: '标题过长' }] }, { idempotencyKey: 'jd-rejected' })).toMatchObject({
      found: true,
      state: 'rejected',
      rejection: { rawCode: 'JD-ATTR-400', message: '属性不符合类目规则', fields: [{ path: 'title', rawCode: 'TITLE-LONG', message: '标题过长' }] },
    })
  })

  it('reads nested provider receipt identity and rejection evidence', () => {
    expect(mapJdWriteStatus({ data: { ware_id: 100, request_id: 'jd-provider-1', error_code: 'JD-400', message: '校验失败' } }, { idempotencyKey: 'jd-nested' })).toMatchObject({
      found: true, state: 'rejected', remoteId: '100', requestId: 'jd-provider-1', rejection: { rawCode: 'JD-400', message: '校验失败' },
    })
  })

  it('drops malformed provider rejection fields without leaking control or oversized evidence', () => {
    const result = mapJdWriteStatus({
      error_code: 'JD-SAFE-400',
      message: '安全错误\u0000\u0001',
      field_errors: [
        { field: 'title\u0000', code: 'FIELD-1', message: 'bad' },
        { field: 'price', code: 'x'.repeat(257), message: 'bad' },
        { field: 'sku', code: 'FIELD-2', message: '可展示的错误' },
      ],
    }, { idempotencyKey: 'jd-malformed-rejection' })

    expect(result.rejection).toEqual({
      rawCode: 'JD-SAFE-400',
      fields: [{ path: 'sku', rawCode: 'FIELD-2', message: '可展示的错误' }],
    })
    expect(JSON.stringify(result)).not.toContain('\\u0000')
  })
})
