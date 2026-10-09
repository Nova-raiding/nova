import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  getMerchantWorkspaceScope,
  requestApi,
  requestMcp,
} from './api.js'

function envelope(workspaceId: string, data: unknown) {
  return new Response(JSON.stringify({
    request_id: 'workspace-scope-request', trace_id: 'workspace-scope-trace', workspace_id: workspaceId,
    data, warnings: [], next_actions: [], error: null,
  }), { headers: { 'content-type': 'application/json' } })
}

describe('merchant active workspace request boundary', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('requires an explicit active workspace for a multi-workspace session and only accepts authorized choices', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'])
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(requestApi('/api', '/v1/products')).rejects.toMatchObject({ code: 'API_WORKSPACE_SCOPE_REQUIRED' })
    expect(() => activateMerchantWorkspace('ws_foreign')).toThrowError(expect.objectContaining({ code: 'API_WORKSPACE_NOT_AUTHORIZED' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(getMerchantWorkspaceScope()).toMatchObject({ workspaceIds: ['ws_alpha', 'ws_beta'], activeWorkspaceId: null })
  })

  it('scopes cookie REST and MCP calls to the selected workspace and rejects caller scope overrides', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'])
    activateMerchantWorkspace('ws_beta')
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (String(_input).endsWith('/mcp')) return envelope('ws_beta', { result: { workspace_id: headers.get('x-workspace-id') } })
      return envelope('ws_beta', { workspace_id: headers.get('x-workspace-id') })
    })
    vi.stubGlobal('fetch', fetch)

    await expect(requestApi<{ workspace_id: string }>('/api', '/v1/products')).resolves.toEqual({ workspace_id: 'ws_beta' })
    await expect(requestMcp<{ workspace_id: string }>('/api', 'workspace.health')).resolves.toEqual({ workspace_id: 'ws_beta' })
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-workspace-id'))).toEqual(['ws_beta', 'ws_beta'])
    await expect(requestMcp('/api', 'workspace.health', {}, 'ws_alpha')).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_MISMATCH' })
    await expect(requestApi('/api', '/v1/products', {}, 'ws_alpha')).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_MISMATCH' })
  })

  it('rejects a successful response from another tenant', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_beta')
    vi.stubGlobal('fetch', vi.fn(async () => envelope('ws_alpha', { secret: 'foreign' })))

    await expect(requestApi('/api', '/v1/products')).rejects.toMatchObject({ code: 'API_WORKSPACE_SCOPE_MISMATCH', status: 502 })
  })

  it('drops a late tenant response after active workspace changes', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve })))
    const pending = requestApi('/api', '/v1/products')

    activateMerchantWorkspace('ws_beta')
    resolveResponse(envelope('ws_alpha', { items: [] }))
    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
