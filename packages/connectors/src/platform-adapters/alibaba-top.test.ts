import { describe, expect, it } from 'vitest'
import { createAlibabaTopSigner, mapAlibabaTopProducts, mapAlibabaTopWriteStatus } from './alibaba-top.js'

describe('Alibaba TOP signer', () => {
  it('builds a signed form request from method, session and business parameters', async () => {
    const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest?method=taobao.item.seller.get', headers: {} as Record<string, string>, body: JSON.stringify({ fields: 'num_iid,title', num_iid: '11223344' }), platform: 'taobao' as const, credential: { accessToken: 'session-1' } }
    const signer = createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', now: () => new Date('2026-08-23T04:05:06Z') })
    await signer.sign(request)
    const body = new URLSearchParams(request.body)
    expect(request.url).toBe('https://gw.api.taobao.com/router/rest')
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
    expect(body.get('method')).toBe('taobao.item.seller.get')
    expect(body.get('session')).toBe('session-1')
    expect(body.get('timestamp')).toBe('2026-08-23 12:05:06')
    expect(body.get('sign')).toMatch(/^[A-F0-9]{64}$/)
  })

  it('supports the legacy TOP md5 signature mode', async () => {
    const request = { method: 'POST', url: 'https://gw.api.taobao.com/router/rest?method=taobao.item.seller.get', headers: {} as Record<string, string>, body: JSON.stringify({ fields: 'title' }), platform: 'taobao' as const }
    const signer = createAlibabaTopSigner({ appKey: '12345678', appSecret: 'secret', signMethod: 'md5', now: () => new Date('2026-08-23T04:05:06Z') })
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
