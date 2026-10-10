import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  getMerchantWorkspaceScope,
  selectVisualCandidates,
} from './api.js'

const envelope = (workspaceId: string, result: unknown) => new Response(JSON.stringify({
  request_id: 'visual-candidate-selection-workspace-switch',
  trace_id: 'visual-candidate-selection-workspace-switch',
  workspace_id: workspaceId,
  data: { jsonrpc: '2.0', id: 'visual-select', result },
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('visual candidate selection workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('binds visual selection to A and rejects its late receipt after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = selectVisualCandidates(
      '/api',
      'content-alpha-v4',
      ['asset-alpha-1', 'asset-alpha-2'],
      9,
      'Select approved campaign images',
      'visual-selection-alpha-v4-r9',
    )
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/mcp')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: 'content.visual.select',
      params: {
        content_version_id: 'content-alpha-v4',
        visual_refs_json: JSON.stringify(['asset-alpha-1', 'asset-alpha-2']),
        expected_revision: '9',
        idempotency_key: 'visual-selection-alpha-v4-r9',
        reason: 'Select approved campaign images',
      },
    })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      content_version_id: 'content-alpha-v4',
      state: 'pending_review',
      revision: 10,
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
