import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  getMerchantWorkspaceScope,
  saveBrandProfile,
} from './api.js'

const envelope = (workspaceId: string, data: unknown) => new Response(JSON.stringify({
  request_id: 'brand-profile-workspace-switch',
  trace_id: 'brand-profile-workspace-switch',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('brand profile save workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('sends a brand profile save in A and rejects its late response after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = saveBrandProfile('/api', {
      name: 'A workspace brand',
      positioning: 'A workspace positioning',
      audience: 'A workspace audience',
      source: 'merchant_edit',
    })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/brand-profile')
    expect(init?.method).toBe('PUT')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: 'A workspace brand',
      positioning: 'A workspace positioning',
      audience: 'A workspace audience',
    })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      id: 'brand-profile-alpha', workspaceId: 'ws_alpha', name: 'A workspace brand', revision: 5,
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
