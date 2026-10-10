import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  createCommercialPurchaseOrder,
  getMerchantWorkspaceScope,
} from './api.js'

const envelope = (workspaceId: string, result: unknown) => new Response(JSON.stringify({
  request_id: 'commercial-order-workspace-switch',
  trace_id: 'commercial-order-workspace-switch',
  workspace_id: workspaceId,
  data: { result },
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('commercial purchase order workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('binds order creation to A and rejects its late response after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = createCommercialPurchaseOrder('/api', 'purchase', 'growth-monthly', 'merchant_commercial_purchase', 'order-alpha-once')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/mcp')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: 'commercial.order.create',
      params: {
        purchase_kind: 'purchase',
        sku_code: 'growth-monthly',
        reason: 'merchant_commercial_purchase',
        idempotency_key: 'order-alpha-once',
      },
    })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      order_id: 'order-alpha', sku_code: 'growth-monthly', sku_version_id: 'sku-version-7',
      status: 'pending', amount_fen: 215000, currency: 'CNY',
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
