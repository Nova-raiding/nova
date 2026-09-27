import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerManualStoreRecord } from './api'

describe('merchant manual store registration request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts only the store identity fields through the authenticated same-origin API session', async () => {
    const store = { platform: 'taobao', accountId: 'shop-123', state: 'manually_registered', readEnabled: false, writeEnabled: false }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      request_id: 'req-manual-store', trace_id: 'trace-manual-store', workspace_id: 'ws_session',
      data: {
        store,
        connection: { mode: 'manual_store_record', token_state: 'manually_registered', credential_free: true, authorization_receipt: null },
      },
      warnings: [], next_actions: [], error: null,
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', globalThis)

    await expect(registerManualStoreRecord('/api', 'taobao', { accountId: ' shop-123 ', storeName: ' 贵人鸟旗舰店 ' })).resolves.toMatchObject({
      store: { accountId: 'shop-123', state: 'manually_registered' },
      connection: { mode: 'manual_store_record', token_state: 'manually_registered', credential_free: true, authorization_receipt: null },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/platform-accounts/taobao/manual-record')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(String(init.body))).toEqual({ account_id: 'shop-123', store_name: '贵人鸟旗舰店' })
    expect(String(init.body)).not.toMatch(/password|cookie|token|workspace_id/iu)
  })
})
