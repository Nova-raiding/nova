import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  getMerchantWorkspaceScope,
  updateAssetRights,
} from './api.js'

const envelope = (workspaceId: string, data: unknown) => new Response(JSON.stringify({
  request_id: 'asset-rights-workspace-switch',
  trace_id: 'asset-rights-workspace-switch',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('asset rights update workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('binds rights confirmation to A and rejects its late receipt after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = updateAssetRights('/api', 'asset-alpha', {
      rights_status: 'approved',
      rights_scope: 'internal_only',
      usage_scopes: ['internal_only'],
      ai_modification_allowed: false,
    })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/assets/asset-alpha/rights')
    expect(init?.method).toBe('PUT')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(JSON.parse(String(init?.body))).toEqual({
      rights_status: 'approved',
      rights_scope: 'internal_only',
      usage_scopes: ['internal_only'],
      ai_modification_allowed: false,
    })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      id: 'asset-alpha', workspaceId: 'ws_alpha', name: 'A private reference.png',
      rightsStatus: 'approved', rightsScope: 'internal_only', revision: 4,
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
