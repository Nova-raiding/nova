import { describe, expect, it } from 'vitest'
import { createPinduoduoSigner, mapPinduoduoProducts, mapPinduoduoWriteStatus } from './pinduoduo.js'

describe('Pinduoduo adapter', () => {
  it('builds a sorted MD5 router form with access token', async () => {
    const request = { method: 'POST', url: 'https://open.pinduoduo.com/api/router?type=pdd.goods.detail', headers: {} as Record<string, string>, body: JSON.stringify({ goods_sign: 'sign-1' }), platform: 'pinduoduo' as const, credential: { accessToken: 'token-1' } }
    await createPinduoduoSigner({ clientId: 'pdd-app', clientSecret: 'secret', now: () => new Date(2026, 7, 23, 4, 5, 6) }).sign(request)
    const body = new URLSearchParams(request.body)
    expect(body.get('type')).toBe('pdd.goods.detail')
    expect(body.get('access_token')).toBe('token-1')
    expect(body.get('data_type')).toBe('JSON')
    expect(body.get('sign')).toMatch(/^[A-F0-9]{32}$/)
    expect(request.headers['content-type']).toContain('application/x-www-form-urlencoded')
  })

  it('maps goods_sign as the stable remote identity', () => {
    const [product] = mapPinduoduoProducts({ goods_search_response: { goods_list: [{ goods_sign: 'gs-1', goods_name: '拼多多商品', min_group_price: 1299, goods_image_url: 'https://img.example/pdd.jpg', stock: 8 }] } })
    expect(product).toMatchObject({ remoteId: 'gs-1', title: '拼多多商品', price: 12.99, stock: 8 })
    expect(mapPinduoduoWriteStatus({ success: true, goods_sign: 'gs-1' }, { idempotencyKey: 'pdd-1' })).toMatchObject({ found: true, state: 'submitted', remoteId: 'gs-1' })
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
