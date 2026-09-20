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

  it('signs the GET read path into the URL query so the request stays dispatchable', async () => {
    // `syncProducts` dispatches with GET; a signed form body there makes
    // `fetch` throw "Request with GET/HEAD method cannot have body" before any
    // network call, so the read path never left the process.
    const request = { method: 'GET', url: 'https://api.jd.com/routerjson', headers: {} as Record<string, string>, body: JSON.stringify({ ware_id: '1' }), platform: 'jd' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
    await createJdSigner({ appKey: 'jd-app', appSecret: 'secret', methods: { sync: 'jd.product.sync' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    expect(request.body).toBeUndefined()
    expect(() => new Request(request.url, { method: 'GET', body: request.body })).not.toThrow()
    const query = new URL(request.url).searchParams
    expect(new URL(request.url).pathname).toBe('/routerjson')
    expect(query.get('method')).toBe('jd.product.sync')
    expect(query.get('360buy_param_json')).toBe('{"ware_id":"1"}')
    expect(query.get('access_token')).toBe('token-1')
    expect(query.get('app_key')).toBe('jd-app')
    expect(query.get('timestamp')).toBe('2026-08-23 12:05:06')
    expect(request.headers['content-type']).toBeUndefined()
    // The parameter set is identical to the form-body test above, so the same
    // documented digest pins the query-string signature: only the transport
    // moved, and the gateway verifies the same canonical string.
    expect(query.get('sign')).toBe('1BEB12E427C2BF00A37FC5CA490FA3DE')
  })

  it('does not let a GET query parameter retarget the signed router method', async () => {
    const request = { method: 'GET', url: 'https://api.jd.com/routerjson?method=jd.ware.delete', headers: {} as Record<string, string>, platform: 'jd' as const, operation: 'sync_products' as const, credential: { accessToken: 'token-1' } }
    await createJdSigner({ appKey: 'jd-app', appSecret: 'secret', methods: { sync: 'jd.product.sync' }, now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    expect(new URL(request.url).searchParams.getAll('method')).toEqual(['jd.product.sync'])
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
