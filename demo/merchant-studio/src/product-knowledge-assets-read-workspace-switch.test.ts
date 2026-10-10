import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  fetchProductKnowledgeAssets,
  getMerchantWorkspaceScope,
} from './api.js'

const envelope = (workspaceId: string, result: unknown) => new Response(JSON.stringify({
  request_id: 'product-knowledge-assets-read-workspace-switch',
  trace_id: 'product-knowledge-assets-read-workspace-switch',
  workspace_id: workspaceId,
  data: { jsonrpc: '2.0', id: 'knowledge-assets', result },
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('product knowledge assets workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('reads knowledge assets in A and rejects the late result after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = fetchProductKnowledgeAssets('/api', 'product-alpha')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/mcp')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'knowledge.asset.list' })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', [{
      id: 'knowledge-asset-alpha',
      productId: 'product-alpha',
      name: 'Alpha product instructions',
      approvalStatus: 'approved',
      rightsStatus: 'cleared',
      indexState: 'ready',
    }]))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
