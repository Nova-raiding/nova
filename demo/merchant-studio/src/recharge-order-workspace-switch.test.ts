import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  createRechargeOrder,
  getMerchantWorkspaceScope,
} from './api.js'

const envelope = (workspaceId: string, result: unknown) => new Response(JSON.stringify({
  request_id: 'recharge-order-workspace-switch',
  trace_id: 'recharge-order-workspace-switch',
  workspace_id: workspaceId,
  data: { result },
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('wallet recharge workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('binds recharge creation to A and rejects its late receipt after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = createRechargeOrder('/api', '100.00', 'alipay', 'recharge-alpha-once')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/mcp')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: 'billing.recharge.create',
      params: { amount_cny: '100.00', channel: 'alipay', idempotency_key: 'recharge-alpha-once' },
    })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      order_id: 'recharge-alpha', status: 'pending', amount_cny: '100.00', channel: 'alipay',
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
