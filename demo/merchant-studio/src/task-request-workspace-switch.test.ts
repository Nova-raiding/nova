import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  createTaskRequest,
  getMerchantWorkspaceScope,
} from './api.js'

const envelope = (workspaceId: string, data: unknown) => new Response(JSON.stringify({
  request_id: 'task-request-workspace-switch',
  trace_id: 'task-request-workspace-switch',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('task request workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('binds a split-task creation request to A and rejects its late response after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = createTaskRequest('/api', '分别为京东和拼多多准备商品内容', 'intent-alpha-once', [
      { platform: 'jd', productId: 'product-alpha' },
      { platform: 'pinduoduo', productId: 'product-alpha-pdd' },
    ])
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/task-requests')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('intent-alpha-once')
    expect(JSON.parse(String(init?.body))).toEqual({ request_text: '分别为京东和拼多多准备商品内容', expected_scopes: [
      { platform: 'jd', product_id: 'product-alpha' },
      { platform: 'pinduoduo', product_id: 'product-alpha-pdd' },
    ] })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      mode: 'split_by_platform', taskGroupId: 'group-alpha', taskIds: ['task-alpha'],
      tasks: [{ id: 'task-alpha', workspaceId: 'ws_alpha', productId: 'product-alpha', platform: 'jd' }], replayed: false,
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
