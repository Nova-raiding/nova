import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  getMerchantWorkspaceScope,
  importProduct,
} from './api.js'

const envelope = (workspaceId: string, data: unknown) => new Response(JSON.stringify({
  request_id: 'product-import-workspace-switch',
  trace_id: 'product-import-workspace-switch',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('product import workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('binds import to A and rejects its late product receipt after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = importProduct('/api', {
      platform: 'taobao',
      account_id: 'store-alpha',
      title: 'Alpha synthetic product',
      remote_id: 'remote-alpha-001',
      store_name: 'Alpha fixture store',
    })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/products/import')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(JSON.parse(String(init?.body))).toEqual({
      platform: 'taobao',
      account_id: 'store-alpha',
      title: 'Alpha synthetic product',
      remote_id: 'remote-alpha-001',
      store_name: 'Alpha fixture store',
    })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      id: 'product-alpha', workspaceId: 'ws_alpha', platform: 'taobao',
      accountId: 'store-alpha', title: 'Alpha synthetic product',
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
