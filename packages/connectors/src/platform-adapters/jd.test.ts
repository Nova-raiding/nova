import { describe, expect, it } from 'vitest'
import { createJdSigner, mapJdProducts, mapJdWriteStatus } from './jd.js'

describe('JD Open Platform adapter', () => {
  it('builds the documented routerjson MD5 form signature', async () => {
    const request = { method: 'POST', url: 'https://api.jd.com/routerjson?method=jd.product.sync', headers: {} as Record<string, string>, body: JSON.stringify({ ware_id: '1' }), platform: 'jd' as const, credential: { accessToken: 'token-1' } }
    await createJdSigner({ appKey: 'jd-app', appSecret: 'secret', now: () => new Date('2026-08-23T04:05:06Z') }).sign(request)
    const body = new URLSearchParams(request.body)
    expect(body.get('360buy_param_json')).toBe('{"ware_id":"1"}')
    expect(body.get('access_token')).toBe('token-1')
    expect(body.get('timestamp')).toBe('2026-08-23 12:05:06')
    expect(body.get('sign')).toBe('1BEB12E427C2BF00A37FC5CA490FA3DE')
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
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
})
