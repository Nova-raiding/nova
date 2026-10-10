import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  getMerchantWorkspaceScope,
  fetchProductPage,
  fetchTaskPage,
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

  it('rejects a late product-directory page after switching workspaces', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveResponse!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { resolveResponse = resolve }))
    vi.stubGlobal('fetch', fetch)
    const pendingPage = fetchProductPage('/api', { query: 'coat', limit: 20, offset: 0 })

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/v1/products?limit=20&offset=0&query=coat')
    activateMerchantWorkspace('ws_beta')
    resolveResponse(envelope('ws_alpha', { items: [{ id: 'alpha-private-product' }], total: 1, limit: 20, offset: 0 }))

    await expect(pendingPage).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })

  it('keeps the B task page when the A task-list response arrives late', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const workspace = new Headers(init?.headers).get('x-workspace-id')
      if (workspace === 'ws_alpha') return new Promise<Response>(resolve => { resolveAlpha = resolve })
      return Promise.resolve(envelope('ws_beta', { items: [{ id: 'task-beta-only', workspaceId: 'ws_beta' }], total: 1, limit: 50, offset: 0 }))
    })
    vi.stubGlobal('fetch', fetch)
    let visibleTasks: Array<{ id: string; workspaceId: string }> = []
    const lateAlpha = fetchTaskPage('/api', { query: 'alpha' })
      .then(page => { visibleTasks = page.items })
      .catch(() => undefined)

    activateMerchantWorkspace('ws_beta')
    const betaPage = await fetchTaskPage('/api', { query: 'beta' })
    visibleTasks = betaPage.items
    expect(visibleTasks.map(task => task.id)).toEqual(['task-beta-only'])
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('x-workspace-id')).toBe('ws_beta')

    resolveAlpha(envelope('ws_alpha', { items: [{ id: 'task-alpha-private', workspaceId: 'ws_alpha' }], total: 1, limit: 50, offset: 0 }))
    await lateAlpha
    expect(visibleTasks).toEqual([{ id: 'task-beta-only', workspaceId: 'ws_beta' }])
  })
})
